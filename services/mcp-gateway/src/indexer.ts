import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Driver } from "neo4j-driver";
import { pino } from "pino";
import { EmbeddingService } from "./embeddings.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// =============================================================================
// TYPES
// =============================================================================

export interface IndexedSymbol {
  id: string;
  name: string;
  qualified_name: string;
  symbol_type: string;
  file_path: string;
  line_start: number;
  line_end: number;
  signature: string;
  namespace: string;
  language: string;
  description: string;
  code_snippet?: string;
}

export interface IndexProgress {
  status: "running" | "completed" | "failed";
  files_found: number;
  files_processed: number;
  files_skipped: number;
  symbols_indexed: number;
  current_file?: string;
  errors: string[];
  started_at: string;
  completed_at?: string;
}

export interface IndexOptions {
  repoPath: string;
  language: string;
  collectionName: string;
  incremental: boolean;
  useLlmDescriptions: boolean;
}

// =============================================================================
// FILE HASH TRACKING (for incremental indexing)
// =============================================================================

function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(content).digest("hex");
}

async function getStoredFileHash(
  neo4jDriver: Driver,
  repoPath: string,
  filePath: string
): Promise<string | null> {
  const session = neo4jDriver.session();
  try {
    const result = await session.run(
      `MATCH (f:File {path: $path, repo: $repo}) RETURN f.hash as hash`,
      { path: filePath, repo: repoPath }
    );
    return result.records[0]?.get("hash") || null;
  } finally {
    await session.close();
  }
}

async function storeFileHash(
  neo4jDriver: Driver,
  repoPath: string,
  filePath: string,
  hash: string
): Promise<void> {
  const session = neo4jDriver.session();
  try {
    await session.run(
      `MERGE (f:File {path: $path, repo: $repo})
       SET f.hash = $hash, f.indexed_at = datetime()`,
      { path: filePath, repo: repoPath, hash }
    );
  } finally {
    await session.close();
  }
}

// =============================================================================
// LANGUAGE PARSERS
// =============================================================================

interface LanguageParser {
  extensions: string[];
  extractNamespace: (content: string) => string;
  patterns: {
    classPattern: RegExp;
    interfacePattern?: RegExp;
    functionPattern: RegExp;
    methodPattern?: RegExp;
  };
  skipNames: string[];
}

const languageParsers: Record<string, LanguageParser> = {
  csharp: {
    extensions: [".cs"],
    extractNamespace: (content) => {
      const match = content.match(/namespace\s+([\w.]+)/);
      return match ? match[1] : "";
    },
    patterns: {
      classPattern: /(?:public|private|internal|protected)?\s*(?:static|abstract|sealed|partial)?\s*class\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*[\w<>,\s]+)?/g,
      interfacePattern: /(?:public|private|internal|protected)?\s*interface\s+(I\w+)(?:<[^>]+>)?/g,
      methodPattern: /(?:public|private|internal|protected)\s+(?:static\s+)?(?:async\s+)?(?:virtual\s+)?(?:override\s+)?(?:[\w<>\[\],\s?]+)\s+(\w+)\s*\([^)]*\)/g,
      functionPattern: /(?:public|private|internal|protected)\s+(?:static\s+)?(?:async\s+)?(?:virtual\s+)?(?:override\s+)?(?:[\w<>\[\],\s?]+)\s+(\w+)\s*\([^)]*\)/g,
    },
    skipNames: ["if", "for", "while", "switch", "catch", "using", "lock", "return", "new", "throw"],
  },

  typescript: {
    extensions: [".ts", ".tsx"],
    extractNamespace: (content) => {
      const nsMatch = content.match(/(?:module|namespace)\s+([\w.]+)/);
      if (nsMatch) return nsMatch[1];
      return "";
    },
    patterns: {
      classPattern: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:<[^>]+>)?(?:\s+(?:extends|implements)\s+[\w<>,\s]+)?/g,
      interfacePattern: /(?:export\s+)?interface\s+(\w+)(?:<[^>]+>)?/g,
      functionPattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)/g,
      methodPattern: /(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>\[\]|&\s]+)?\s*\{/g,
    },
    skipNames: ["if", "for", "while", "switch", "catch", "constructor", "return", "throw", "new"],
  },

  javascript: {
    extensions: [".js", ".jsx"],
    extractNamespace: () => "",
    patterns: {
      classPattern: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?/g,
      functionPattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g,
      methodPattern: /(\w+)\s*(?:=\s*)?(?:async\s+)?\([^)]*\)\s*(?:=>|{)/g,
    },
    skipNames: ["if", "for", "while", "switch", "catch", "constructor", "return", "throw", "new", "function"],
  },

  python: {
    extensions: [".py"],
    extractNamespace: () => "",
    patterns: {
      classPattern: /class\s+(\w+)(?:\([^)]*\))?:/g,
      functionPattern: /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)/g,
    },
    skipNames: ["__init__", "__str__", "__repr__", "__eq__", "__hash__", "__len__"],
  },
};

// =============================================================================
// SYMBOL EXTRACTION
// =============================================================================

export function parseFileContent(
  content: string,
  relativePath: string,
  language: string,
  repoPath: string
): IndexedSymbol[] {
  const parser = languageParsers[language];
  if (!parser) {
    logger.warn({ language }, "No parser available for language");
    return [];
  }

  const symbols: IndexedSymbol[] = [];
  const namespace = parser.extractNamespace(content);
  const lines = content.split("\n");

  const getLineNumber = (index: number) => content.substring(0, index).split("\n").length;

  const extractSnippet = (startIndex: number, maxLines: number = 5): string => {
    const startLine = getLineNumber(startIndex) - 1;
    const snippet = lines.slice(startLine, startLine + maxLines).join("\n");
    return snippet.length > 500 ? snippet.substring(0, 500) + "..." : snippet;
  };

  // Extract classes
  let match;
  const classPattern = new RegExp(parser.patterns.classPattern.source, "g");
  while ((match = classPattern.exec(content)) !== null) {
    const name = match[1];
    const lineNumber = getLineNumber(match.index);
    symbols.push({
      id: `${repoPath}:${namespace ? namespace + "." : ""}${name}`,
      name,
      qualified_name: namespace ? `${namespace}.${name}` : name,
      symbol_type: "class",
      file_path: relativePath,
      line_start: lineNumber,
      line_end: lineNumber,
      signature: match[0].trim(),
      namespace,
      language,
      description: "",
      code_snippet: extractSnippet(match.index, 10),
    });
  }

  // Extract interfaces
  if (parser.patterns.interfacePattern) {
    const interfacePattern = new RegExp(parser.patterns.interfacePattern.source, "g");
    while ((match = interfacePattern.exec(content)) !== null) {
      const name = match[1];
      const lineNumber = getLineNumber(match.index);
      symbols.push({
        id: `${repoPath}:${namespace ? namespace + "." : ""}${name}`,
        name,
        qualified_name: namespace ? `${namespace}.${name}` : name,
        symbol_type: "interface",
        file_path: relativePath,
        line_start: lineNumber,
        line_end: lineNumber,
        signature: match[0].trim(),
        namespace,
        language,
        description: "",
        code_snippet: extractSnippet(match.index, 8),
      });
    }
  }

  // Extract functions/methods
  const funcPattern = parser.patterns.methodPattern || parser.patterns.functionPattern;
  const funcPatternGlobal = new RegExp(funcPattern.source, "g");
  while ((match = funcPatternGlobal.exec(content)) !== null) {
    const name = match[1];
    if (parser.skipNames.includes(name)) continue;

    const lineNumber = getLineNumber(match.index);
    symbols.push({
      id: `${repoPath}:${namespace ? namespace + "." : ""}${name}`,
      name,
      qualified_name: namespace ? `${namespace}.${name}` : name,
      symbol_type: language === "python" ? "function" : "method",
      file_path: relativePath,
      line_start: lineNumber,
      line_end: lineNumber,
      signature: match[0].trim(),
      namespace,
      language,
      description: "",
      code_snippet: extractSnippet(match.index, 8),
    });
  }

  return symbols;
}

// =============================================================================
// LLM DESCRIPTION GENERATION
// =============================================================================

export async function generateLlmDescription(
  symbol: IndexedSymbol,
  ollamaUrl: string,
  model: string = "llama3.2"
): Promise<string> {
  const prompt = `Describe what this ${symbol.symbol_type} does in one concise sentence (max 100 chars). Focus on the behavior/purpose, not implementation details.

${symbol.symbol_type}: ${symbol.name}
Signature: ${symbol.signature}
${symbol.code_snippet ? `Code:\n${symbol.code_snippet}` : ""}

Description:`;

  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 50 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.statusText}`);
    }

    const result = await response.json() as { response: string };
    return result.response.trim().replace(/^["']|["']$/g, "");
  } catch (err) {
    logger.debug({ error: (err as Error).message, symbol: symbol.name }, "LLM description failed, using fallback");
    return generateFallbackDescription(symbol);
  }
}

export function generateFallbackDescription(symbol: IndexedSymbol): string {
  const readable = symbol.name
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();

  switch (symbol.symbol_type) {
    case "class":
      return `${readable} class${symbol.namespace ? ` in ${symbol.namespace}` : ""}`;
    case "interface":
      return `${readable} interface defining contract${symbol.namespace ? ` in ${symbol.namespace}` : ""}`;
    case "method":
    case "function":
      return `${readable}. ${symbol.signature.substring(0, 100)}`;
    default:
      return `${symbol.symbol_type} ${readable}`;
  }
}

// =============================================================================
// FILE WATCHER
// =============================================================================

interface WatcherState {
  watcher: fs.FSWatcher;
  repoPath: string;
  language: string;
  collectionName: string;
  pendingFiles: Set<string>;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

const activeWatchers = new Map<string, WatcherState>();

export function startWatcher(
  watchId: string,
  repoPath: string,
  language: string,
  collectionName: string,
  qdrant: QdrantClient,
  neo4jDriver: Driver,
  embeddingService: EmbeddingService,
  ollamaUrl: string,
  useLlmDescriptions: boolean
): { watch_id: string; status: string; message: string } {
  if (activeWatchers.has(watchId)) {
    return { watch_id: watchId, status: "exists", message: "Watcher already active" };
  }

  const parser = languageParsers[language];
  if (!parser) {
    return { watch_id: watchId, status: "failed", message: `Unsupported language: ${language}` };
  }

  const state: WatcherState = {
    watcher: null as unknown as fs.FSWatcher,
    repoPath,
    language,
    collectionName,
    pendingFiles: new Set(),
  };

  const processChanges = async () => {
    if (state.pendingFiles.size === 0) return;

    const files = Array.from(state.pendingFiles);
    state.pendingFiles.clear();

    logger.info({ watchId, fileCount: files.length }, "Processing file changes");

    for (const filePath of files) {
      try {
        if (!fs.existsSync(filePath)) {
          await removeFileFromIndex(filePath, repoPath, collectionName, qdrant, neo4jDriver);
          continue;
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const relativePath = path.relative(repoPath, filePath);
        const symbols = parseFileContent(content, relativePath, language, repoPath);

        for (const symbol of symbols) {
          symbol.description = useLlmDescriptions
            ? await generateLlmDescription(symbol, ollamaUrl)
            : generateFallbackDescription(symbol);
        }

        await indexSymbols(symbols, collectionName, qdrant, neo4jDriver, embeddingService);

        const hash = computeFileHash(filePath);
        await storeFileHash(neo4jDriver, repoPath, relativePath, hash);

        logger.info({ filePath: relativePath, symbols: symbols.length }, "File reindexed");
      } catch (err) {
        logger.error({ filePath, error: (err as Error).message }, "Failed to reindex file");
      }
    }
  };

  const watcher = fs.watch(repoPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    const fullPath = path.join(repoPath, filename);
    const ext = path.extname(filename);

    if (!parser.extensions.includes(ext)) return;

    if (filename.includes("node_modules") || filename.includes(".git") || filename.includes("bin") || filename.includes("obj")) {
      return;
    }

    state.pendingFiles.add(fullPath);

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(processChanges, 500);
  });

  state.watcher = watcher;
  activeWatchers.set(watchId, state);

  logger.info({ watchId, repoPath, language }, "File watcher started");

  return {
    watch_id: watchId,
    status: "started",
    message: `Watching ${repoPath} for ${language} file changes`,
  };
}

export function stopWatcher(watchId: string): { status: string; message: string } {
  const state = activeWatchers.get(watchId);
  if (!state) {
    return { status: "not_found", message: "Watcher not found" };
  }

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
  }
  state.watcher.close();
  activeWatchers.delete(watchId);

  logger.info({ watchId }, "File watcher stopped");

  return { status: "stopped", message: "Watcher stopped" };
}

export function listWatchers(): Array<{ watch_id: string; repo_path: string; language: string }> {
  return Array.from(activeWatchers.entries()).map(([id, state]) => ({
    watch_id: id,
    repo_path: state.repoPath,
    language: state.language,
  }));
}

// =============================================================================
// INDEXING HELPERS
// =============================================================================

async function removeFileFromIndex(
  filePath: string,
  repoPath: string,
  collectionName: string,
  qdrant: QdrantClient,
  neo4jDriver: Driver
): Promise<void> {
  const relativePath = path.relative(repoPath, filePath);

  const session = neo4jDriver.session();
  try {
    await session.run(
      `MATCH (s:Symbol)-[:DEFINED_IN]->(f:File {path: $path})
       DETACH DELETE s, f`,
      { path: relativePath }
    );
  } finally {
    await session.close();
  }

  await qdrant.delete(collectionName, {
    filter: {
      must: [{ key: "file_path", match: { value: relativePath } }],
    },
  });

  logger.info({ filePath: relativePath }, "Removed file from index");
}

export async function indexSymbols(
  symbols: IndexedSymbol[],
  collectionName: string,
  qdrant: QdrantClient,
  neo4jDriver: Driver,
  embeddingService: EmbeddingService
): Promise<void> {
  if (symbols.length === 0) return;

  // Generate dual embeddings (description + code) for each symbol
  const dualEmbeddings = await embeddingService.embedBatchDual(
    symbols.map((s) => ({
      description: s.description,
      code: s.code_snippet || s.signature,  // Use code snippet if available, else signature
    }))
  );

  // Create points with named vectors for Qdrant
  const points = symbols.map((symbol, idx) => ({
    id: hashString(symbol.id),
    vector: {
      description: dualEmbeddings[idx].description,
      code: dualEmbeddings[idx].code,
    },
    payload: {
      symbol_id: symbol.id,
      name: symbol.name,
      qualified_name: symbol.qualified_name,
      symbol_type: symbol.symbol_type,
      file_path: symbol.file_path,
      line_start: symbol.line_start,
      line_end: symbol.line_end,
      signature: symbol.signature,
      namespace: symbol.namespace,
      language: symbol.language,
      usage_count: 0,
    },
  }));

  await qdrant.upsert(collectionName, { points });

  const session = neo4jDriver.session();
  try {
    for (const symbol of symbols) {
      await session.run(
        `MERGE (s:Symbol {id: $id})
         SET s.name = $name,
             s.qualified_name = $qualified_name,
             s.symbol_type = $symbol_type,
             s.file_path = $file_path,
             s.line_start = $line_start,
             s.namespace = $namespace,
             s.language = $language,
             s.signature = $signature
         MERGE (f:File {path: $file_path})
         MERGE (s)-[:DEFINED_IN]->(f)
         WITH s
         MERGE (n:Namespace {name: $namespace})
         MERGE (s)-[:IN_NAMESPACE]->(n)`,
        {
          id: symbol.id,
          name: symbol.name,
          qualified_name: symbol.qualified_name,
          symbol_type: symbol.symbol_type,
          file_path: symbol.file_path,
          line_start: symbol.line_start,
          namespace: symbol.namespace || "",
          language: symbol.language,
          signature: symbol.signature,
        }
      );
    }
  } finally {
    await session.close();
  }
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// =============================================================================
// MAIN INDEXING FUNCTION
// =============================================================================

export async function indexRepository(
  options: IndexOptions,
  progress: IndexProgress,
  qdrant: QdrantClient,
  neo4jDriver: Driver,
  embeddingService: EmbeddingService,
  ollamaUrl: string,
  embeddingDimensions: number
): Promise<void> {
  const { repoPath, language, collectionName, incremental, useLlmDescriptions } = options;

  logger.info({ repoPath, language, incremental, useLlmDescriptions }, "Starting repository indexing");

  // Ensure Qdrant collection exists with named vectors
  try {
    await qdrant.getCollection(collectionName);
  } catch {
    // Create collection with named vectors for dual embeddings
    const modelConfigs = embeddingService.getModelConfigs();
    await qdrant.createCollection(collectionName, {
      vectors: {
        description: { size: modelConfigs.description.dimensions, distance: "Cosine" },
        code: { size: modelConfigs.code.dimensions, distance: "Cosine" },
      },
    });
    logger.info({ collectionName, vectors: ["description", "code"] }, "Created Qdrant collection with named vectors");
  }

  const parser = languageParsers[language];
  if (!parser) {
    throw new Error(`Unsupported language: ${language}`);
  }

  const files = findSourceFiles(repoPath, parser.extensions);
  progress.files_found = files.length;
  progress.files_skipped = 0;

  logger.info({ fileCount: files.length }, "Found source files");

  const allSymbols: IndexedSymbol[] = [];

  for (const filePath of files) {
    progress.current_file = filePath;

    try {
      const relativePath = path.relative(repoPath, filePath);

      if (incremental) {
        const currentHash = computeFileHash(filePath);
        const storedHash = await getStoredFileHash(neo4jDriver, repoPath, relativePath);

        if (storedHash === currentHash) {
          progress.files_skipped++;
          continue;
        }

        await storeFileHash(neo4jDriver, repoPath, relativePath, currentHash);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const symbols = parseFileContent(content, relativePath, language, repoPath);

      for (const symbol of symbols) {
        symbol.description = useLlmDescriptions
          ? await generateLlmDescription(symbol, ollamaUrl)
          : generateFallbackDescription(symbol);
      }

      allSymbols.push(...symbols);
      progress.files_processed++;
    } catch (err) {
      progress.errors.push(`Failed to process ${filePath}: ${(err as Error).message}`);
    }
  }

  logger.info({ symbolCount: allSymbols.length }, "Extracted symbols");

  const batchSize = 10;
  for (let i = 0; i < allSymbols.length; i += batchSize) {
    const batch = allSymbols.slice(i, i + batchSize);
    await indexSymbols(batch, collectionName, qdrant, neo4jDriver, embeddingService);
    progress.symbols_indexed += batch.length;
  }

  progress.status = "completed";
  progress.completed_at = new Date().toISOString();

  logger.info({
    symbols: allSymbols.length,
    filesProcessed: progress.files_processed,
    filesSkipped: progress.files_skipped,
  }, "Repository indexing completed");
}

function findSourceFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (["node_modules", "bin", "obj", ".git", ".vs", "packages", "__pycache__", ".venv", "venv", "dist", "build"].includes(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (extensions.some((ext) => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

export function getSupportedLanguages(): string[] {
  return Object.keys(languageParsers);
}

export function getLanguageExtensions(language: string): string[] {
  return languageParsers[language]?.extensions || [];
}
