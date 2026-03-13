import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import neo4j, { Driver } from "neo4j-driver";
import { pino } from "pino";
import express, { Request, Response } from "express";
import { loadConfig, RankingConfig } from "./config.js";
import { ReuseScorer } from "./scoring.js";
import { EmbeddingService } from "./embeddings.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const config = {
  qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
  neo4jUrl: process.env.NEO4J_URL || "bolt://localhost:7687",
  neo4jUser: process.env.NEO4J_USER || "neo4j",
  neo4jPassword: process.env.NEO4J_PASSWORD || "codebase-brain-dev",
  zoektUrl: process.env.ZOEKT_URL || "http://localhost:6070",
  roslynUrl: process.env.ROSLYN_URL || "http://localhost:5080",
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  embeddingModel: process.env.EMBEDDING_MODEL || "all-minilm",
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "384"),
};

// =============================================================================
// CLIENTS
// =============================================================================

let qdrant: QdrantClient;
let neo4jDriver: Driver;
let embeddingService: EmbeddingService;
let scorer: ReuseScorer;
let rankingConfig: RankingConfig;

async function initClients() {
  qdrant = new QdrantClient({ url: config.qdrantUrl });
  neo4jDriver = neo4j.driver(
    config.neo4jUrl,
    neo4j.auth.basic(config.neo4jUser, config.neo4jPassword)
  );

  embeddingService = new EmbeddingService(config.ollamaUrl, config.embeddingModel);
  rankingConfig = await loadConfig();
  scorer = new ReuseScorer(rankingConfig);

  logger.info("Clients initialized");
}

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

async function findExistingBehavior(params: {
  description: string;
  language: string;
  namespace?: string;
  symbol_type?: string;
  limit?: number;
}) {
  const limit = Math.floor(params.limit || 10);  // Ensure integer for Qdrant
  const startTime = Date.now();

  // Generate embedding for the description
  const embedding = await embeddingService.embed(params.description);

  // Search Qdrant for semantic matches
  const semanticResults = await qdrant.search("code_chunks", {
    vector: embedding,
    filter: {
      must: [
        { key: "language", match: { value: params.language } },
        ...(params.namespace
          ? [{ key: "namespace", match: { value: params.namespace } }]
          : []),
        ...(params.symbol_type && params.symbol_type !== "any"
          ? [{ key: "symbol_type", match: { value: params.symbol_type } }]
          : []),
      ],
    },
    limit: limit * 2, // Get extra for scoring/filtering
    with_payload: true,
  });

  // Enrich with usage data from Neo4j (run sequentially to avoid session conflicts)
  const candidates = [];
  for (const result of semanticResults) {
    const payload = result.payload as Record<string, unknown>;
    const symbolId = payload.symbol_id as string;

    // Get usage count from Neo4j (use payload if available, skip Neo4j for now)
    const usageCount = (payload.usage_count as number) || 0;

    // Score the candidate
    const score = scorer.score({
      semanticSimilarity: result.score || 0,
      usageCount,
      namespace: payload.namespace as string,
      targetNamespace: params.namespace,
      isDeprecated: false,
      isTest: (payload.file_path as string)?.includes("/test"),
      isGenerated: false,
    });

    candidates.push({
      symbol_id: symbolId,
      name: payload.name,
      signature: payload.signature,
      file_path: payload.file_path,
      line_number: payload.line_start,
      namespace: payload.namespace,
      similarity_score: score.total,
      usage_count: usageCount,
      recommendation: score.recommendation,
      recommendation_reason: score.reason,
    });
  }

  // Sort by score and limit
  candidates.sort((a, b) => b.similarity_score - a.similarity_score);
  const topCandidates = candidates.slice(0, limit);

  return {
    candidates: topCandidates,
    search_metadata: {
      semantic_matches: semanticResults.length,
      lexical_matches: 0, // TODO: integrate Zoekt
      structural_matches: 0, // TODO: integrate Roslyn
      search_time_ms: Date.now() - startTime,
    },
  };
}

async function findSymbols(params: {
  query: string;
  language?: string;
  symbol_type?: string;
  return_type?: string;
  namespace?: string;
  include_implementations?: boolean;
  include_references?: boolean;
  limit?: number;
}) {
  const limit = Math.floor(params.limit || 20);  // Ensure integer for Neo4j LIMIT
  const session = neo4jDriver.session();

  try {
    // Build the Cypher query
    const conditions: string[] = [];
    const queryParams: Record<string, unknown> = { limit };

    // Handle wildcards in query
    if (params.query.includes("*")) {
      const pattern = params.query.replace(/\*/g, ".*");
      conditions.push(`s.name =~ $namePattern`);
      queryParams.namePattern = `(?i)${pattern}`;
    } else {
      conditions.push(`s.name CONTAINS $query`);
      queryParams.query = params.query;
    }

    if (params.language && params.language !== "any") {
      conditions.push(`s.language = $language`);
      queryParams.language = params.language;
    }

    if (params.symbol_type && params.symbol_type !== "any") {
      conditions.push(`s.symbol_type = $symbolType`);
      queryParams.symbolType = params.symbol_type;
    }

    if (params.namespace) {
      conditions.push(`s.namespace CONTAINS $namespace`);
      queryParams.namespace = params.namespace;
    }

    if (params.return_type) {
      conditions.push(`s.return_type = $returnType`);
      queryParams.returnType = params.return_type;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await session.run(
      `MATCH (s:Symbol)
       ${whereClause}
       OPTIONAL MATCH (s)-[:DEFINED_IN]->(f:File)
       RETURN s, f.path as file_path
       LIMIT $limit`,
      queryParams
    );

    const symbols = result.records.map((record) => {
      const s = record.get("s").properties;
      return {
        symbol_id: s.id,
        name: s.name,
        qualified_name: s.qualified_name,
        symbol_type: s.symbol_type,
        signature: s.signature,
        file_path: record.get("file_path"),
        line_number: s.line_start,
        namespace: s.namespace,
        modifiers: s.modifiers,
        return_type: s.return_type,
      };
    });

    // Optionally include implementations
    if (params.include_implementations) {
      for (const symbol of symbols) {
        if (symbol.symbol_type === "interface") {
          const implResult = await session.run(
            `MATCH (c:Class)-[:IMPLEMENTS]->(i:Interface {id: $symbolId})
             RETURN c.name as name, c.id as id`,
            { symbolId: symbol.symbol_id }
          );
          (symbol as Record<string, unknown>).implementations = implResult.records.map(
            (r) => ({
              name: r.get("name"),
              symbol_id: r.get("id"),
            })
          );
        }
      }
    }

    // Optionally include reference counts
    if (params.include_references) {
      for (const symbol of symbols) {
        const refResult = await session.run(
          `MATCH (s:Symbol {id: $symbolId})<-[:CALLS|DEPENDS_ON]-(ref)
           RETURN count(ref) as ref_count`,
          { symbolId: symbol.symbol_id }
        );
        (symbol as Record<string, unknown>).reference_count =
          refResult.records[0]?.get("ref_count")?.toNumber() || 0;
      }
    }

    return { symbols };
  } finally {
    await session.close();
  }
}

async function traceUsage(params: {
  symbol_id?: string;
  symbol_path?: string;
  depth?: number;
  include_tests?: boolean;
}) {
  const session = neo4jDriver.session();
  const depth = params.depth || 2;

  try {
    let symbolId = params.symbol_id;

    // Resolve symbol_path to symbol_id if needed
    if (!symbolId && params.symbol_path) {
      const [filePath, symbolName] = params.symbol_path.split(":");
      const result = await session.run(
        `MATCH (s:Symbol)-[:DEFINED_IN]->(f:File {path: $filePath})
         WHERE s.name = $symbolName
         RETURN s.id as id`,
        { filePath, symbolName }
      );
      symbolId = result.records[0]?.get("id");
    }

    if (!symbolId) {
      return { error: "Symbol not found" };
    }

    // Get callers (fan-in)
    const callersResult = await session.run(
      `MATCH path = (caller:Symbol)-[:CALLS*1..${depth}]->(s:Symbol {id: $symbolId})
       ${params.include_tests ? "" : "WHERE NOT caller.is_test"}
       RETURN DISTINCT caller.name as name, caller.id as id, caller.file_path as file_path,
              length(path) as distance`,
      { symbolId }
    );

    // Get callees (fan-out)
    const calleesResult = await session.run(
      `MATCH path = (s:Symbol {id: $symbolId})-[:CALLS*1..${depth}]->(callee:Symbol)
       RETURN DISTINCT callee.name as name, callee.id as id, callee.file_path as file_path,
              length(path) as distance`,
      { symbolId }
    );

    // Get symbol info
    const symbolResult = await session.run(
      `MATCH (s:Symbol {id: $symbolId})-[:DEFINED_IN]->(f:File)
       RETURN s, f.path as file_path`,
      { symbolId }
    );

    const symbolProps = symbolResult.records[0]?.get("s")?.properties;

    // Calculate metrics
    const fanIn = callersResult.records.length;
    const fanOut = calleesResult.records.length;

    // Simple centrality: normalized by total edges
    const centrality = (fanIn + fanOut) / Math.max(fanIn + fanOut, 1);

    // Check test coverage
    const testResult = await session.run(
      `MATCH (test:Symbol)-[:CALLS]->(s:Symbol {id: $symbolId})
       WHERE test.is_test = true
       RETURN count(test) > 0 as has_tests`,
      { symbolId }
    );
    const hasTests = testResult.records[0]?.get("has_tests") || false;

    return {
      symbol: {
        id: symbolId,
        name: symbolProps?.name,
        file_path: symbolResult.records[0]?.get("file_path"),
        line_number: symbolProps?.line_start,
      },
      callers: callersResult.records.map((r) => ({
        name: r.get("name"),
        symbol_id: r.get("id"),
        file_path: r.get("file_path"),
        distance: r.get("distance").toNumber(),
      })),
      callees: calleesResult.records.map((r) => ({
        name: r.get("name"),
        symbol_id: r.get("id"),
        file_path: r.get("file_path"),
        distance: r.get("distance").toNumber(),
      })),
      metrics: {
        fan_in: fanIn,
        fan_out: fanOut,
        centrality_score: centrality,
        test_coverage: hasTests,
      },
    };
  } finally {
    await session.close();
  }
}

async function detectDuplicates(params: {
  code?: string;
  description?: string;
  language: string;
  threshold?: number;
}) {
  const threshold = params.threshold || 0.7;

  // Generate embedding from code or description
  const textToEmbed = params.code || params.description || "";
  const embedding = await embeddingService.embed(textToEmbed);

  // Search for similar code chunks
  const results = await qdrant.search("code_chunks", {
    vector: embedding,
    filter: {
      must: [{ key: "language", match: { value: params.language } }],
    },
    limit: 20,
    with_payload: true,
    score_threshold: threshold,
  });

  const duplicates = results.map((result) => {
    const payload = result.payload as Record<string, unknown>;
    const similarity = result.score || 0;

    // Classify duplicate type
    let duplicateType: "exact" | "near" | "semantic" = "semantic";
    if (similarity > 0.98) duplicateType = "exact";
    else if (similarity > 0.85) duplicateType = "near";

    return {
      symbol_id: payload.symbol_id,
      name: payload.name,
      file_path: payload.file_path,
      line_number: payload.line_start,
      similarity,
      duplicate_type: duplicateType,
      overlap_explanation:
        duplicateType === "exact"
          ? "Identical or near-identical code"
          : duplicateType === "near"
            ? "Same structure with minor differences"
            : "Similar behavior, different implementation",
    };
  });

  const hasDuplicates = duplicates.length > 0;
  let recommendation: "proceed" | "reuse_existing" | "extend_existing" | "needs_review" =
    "proceed";

  if (duplicates.some((d) => d.duplicate_type === "exact")) {
    recommendation = "reuse_existing";
  } else if (duplicates.some((d) => d.duplicate_type === "near")) {
    recommendation = "extend_existing";
  } else if (duplicates.length > 3) {
    recommendation = "needs_review";
  }

  return {
    has_duplicates: hasDuplicates,
    duplicates,
    recommendation,
  };
}

async function preWriteGuard(params: {
  proposed_change: {
    type: string;
    name: string;
    description: string;
    file_path?: string;
    code_preview?: string;
  };
  search_evidence: {
    behavior_search_performed?: boolean;
    symbol_search_performed?: boolean;
    duplicate_check_performed?: boolean;
    candidates_reviewed?: string[];
    rejection_reasons?: Record<string, string>;
  };
  justification: string;
}) {
  const missingSteps: string[] = [];
  const concerns: string[] = [];
  const suggestions: Array<{ action: string; target_symbol?: string; rationale: string }> =
    [];

  // Check required searches
  if (!params.search_evidence.behavior_search_performed) {
    missingSteps.push("Behavior search not performed - call find_existing_behavior first");
  }
  if (!params.search_evidence.symbol_search_performed) {
    missingSteps.push("Symbol search not performed - call find_symbols first");
  }
  if (!params.search_evidence.duplicate_check_performed) {
    missingSteps.push("Duplicate check not performed - call detect_duplicates first");
  }

  // Check candidate review
  const reviewedCount = params.search_evidence.candidates_reviewed?.length || 0;
  if (reviewedCount < 3 && params.proposed_change.type.startsWith("new_")) {
    concerns.push(
      `Only ${reviewedCount} candidates reviewed - recommend reviewing at least 3`
    );
  }

  // Check justification
  if (!params.justification || params.justification.length < 20) {
    concerns.push("Justification is too brief - explain why existing code is insufficient");
  }

  // Run duplicate check if code preview provided
  if (params.proposed_change.code_preview) {
    const duplicateResult = await detectDuplicates({
      code: params.proposed_change.code_preview,
      language: "csharp", // TODO: detect from file path
      threshold: 0.8,
    });

    if (duplicateResult.has_duplicates) {
      const topDup = duplicateResult.duplicates[0];
      if (topDup.duplicate_type === "exact") {
        concerns.push(`Exact duplicate found: ${topDup.name} at ${topDup.file_path}`);
        suggestions.push({
          action: "reuse",
          target_symbol: topDup.symbol_id as string,
          rationale: "Identical code already exists",
        });
      } else if (topDup.duplicate_type === "near") {
        concerns.push(`Near duplicate found: ${topDup.name} (${Math.round(topDup.similarity * 100)}% similar)`);
        suggestions.push({
          action: "extend",
          target_symbol: topDup.symbol_id as string,
          rationale: "Very similar code exists - consider extending instead",
        });
      }
    }
  }

  // Determine verdict
  let verdict: "proceed" | "blocked" | "needs_human_review" = "proceed";
  let approved = true;

  if (missingSteps.length > 0) {
    verdict = "blocked";
    approved = false;
  } else if (concerns.some((c) => c.includes("Exact duplicate"))) {
    verdict = "blocked";
    approved = false;
  } else if (concerns.length > 0) {
    verdict = "needs_human_review";
  }

  return {
    approved,
    verdict,
    missing_steps: missingSteps,
    concerns,
    suggestions,
    audit_record: {
      timestamp: new Date().toISOString(),
      proposed_change: params.proposed_change,
      evidence_provided: params.search_evidence,
      verdict,
    },
  };
}

async function getArchitectureContext(params: { file_path?: string; namespace?: string }) {
  const session = neo4jDriver.session();

  try {
    let namespace = params.namespace;

    // Derive namespace from file path if not provided
    if (!namespace && params.file_path) {
      // Simple heuristic: use directory structure
      const parts = params.file_path.split("/");
      namespace = parts.slice(0, -1).join(".");
    }

    if (!namespace) {
      return { error: "Namespace or file path required" };
    }

    // Get layer information
    const layerResult = await session.run(
      `MATCH (n:Namespace {name: $namespace})-[:BELONGS_TO]->(l:ArchLayer)
       RETURN l.name as layer`,
      { namespace }
    );

    // Get allowed/forbidden dependencies
    const depsResult = await session.run(
      `MATCH (n:Namespace {name: $namespace})
       OPTIONAL MATCH (n)-[:ALLOWED_DEPENDENCY]->(allowed:Namespace)
       OPTIONAL MATCH (n)-[:FORBIDDEN_DEPENDENCY]->(forbidden:Namespace)
       RETURN collect(DISTINCT allowed.name) as allowed,
              collect(DISTINCT forbidden.name) as forbidden`,
      { namespace }
    );

    // Find similar files in the same area
    const similarResult = await session.run(
      `MATCH (f:File)-[:IN_NAMESPACE]->(n:Namespace)
       WHERE n.name STARTS WITH $namespacePrefix
       RETURN f.path as path
       LIMIT 5`,
      { namespacePrefix: namespace.split(".").slice(0, 2).join(".") }
    );

    // Detect patterns from class names
    const patternsResult = await session.run(
      `MATCH (s:Symbol)-[:IN_NAMESPACE]->(n:Namespace {name: $namespace})
       WHERE s.symbol_type = 'class'
       RETURN s.name as name`,
      { namespace }
    );

    const patterns: string[] = [];
    patternsResult.records.forEach((r) => {
      const name = r.get("name") as string;
      if (name.endsWith("Repository")) patterns.push("Repository");
      if (name.endsWith("Service")) patterns.push("Service");
      if (name.endsWith("Handler")) patterns.push("CQRS Handler");
      if (name.endsWith("Controller")) patterns.push("Controller");
      if (name.endsWith("Factory")) patterns.push("Factory");
    });

    // Infer layer from namespace if not in graph
    let layer = layerResult.records[0]?.get("layer");
    if (!layer) {
      if (namespace.includes("Domain")) layer = "domain";
      else if (namespace.includes("Application")) layer = "application";
      else if (namespace.includes("Infrastructure")) layer = "infrastructure";
      else if (namespace.includes("Api") || namespace.includes("Web")) layer = "presentation";
      else if (namespace.includes("Test")) layer = "tests";
      else layer = "shared";
    }

    return {
      layer,
      bounded_context: namespace.split(".")[1] || namespace,
      allowed_dependencies: depsResult.records[0]?.get("allowed") || [],
      forbidden_dependencies: depsResult.records[0]?.get("forbidden") || [],
      patterns_in_use: [...new Set(patterns)],
      similar_files: similarResult.records.map((r) => r.get("path")),
    };
  } finally {
    await session.close();
  }
}

// =============================================================================
// MCP SERVER
// =============================================================================

const server = new Server(
  {
    name: "codebase-brain",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "find_existing_behavior",
        description:
          "Search for existing code that implements a described behavior. Use this BEFORE writing any new function, method, or class.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string", description: "Natural language description of the behavior" },
            language: { type: "string", enum: ["csharp", "typescript", "javascript", "python", "go", "java"] },
            namespace: { type: "string", description: "Optional namespace filter" },
            symbol_type: { type: "string", enum: ["method", "class", "interface", "any"], default: "any" },
            limit: { type: "integer", default: 10 },
          },
          required: ["description", "language"],
        },
      },
      {
        name: "find_symbols",
        description: "Search for symbols by name or pattern. Supports wildcards.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol name or pattern (e.g., 'I*Service')" },
            language: { type: "string", default: "any" },
            symbol_type: { type: "string", default: "any" },
            namespace: { type: "string" },
            include_implementations: { type: "boolean", default: true },
            include_references: { type: "boolean", default: false },
            limit: { type: "integer", default: 20 },
          },
          required: ["query"],
        },
      },
      {
        name: "trace_usage",
        description: "Trace the usage graph of a symbol - callers, callees, and centrality.",
        inputSchema: {
          type: "object",
          properties: {
            symbol_id: { type: "string" },
            symbol_path: { type: "string", description: "Alternative: file:symbol format" },
            depth: { type: "integer", default: 2 },
            include_tests: { type: "boolean", default: false },
          },
        },
      },
      {
        name: "detect_duplicates",
        description: "Check if proposed code duplicates existing functionality.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "Proposed code to check" },
            description: { type: "string", description: "Or describe what the code does" },
            language: { type: "string" },
            threshold: { type: "number", default: 0.7 },
          },
          required: ["language"],
        },
      },
      {
        name: "pre_write_guard",
        description: "REQUIRED before creating new code. Validates search evidence and justification.",
        inputSchema: {
          type: "object",
          properties: {
            proposed_change: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["new_method", "new_class", "new_file", "modify_existing"] },
                name: { type: "string" },
                description: { type: "string" },
                file_path: { type: "string" },
                code_preview: { type: "string" },
              },
              required: ["type", "name", "description"],
            },
            search_evidence: {
              type: "object",
              properties: {
                behavior_search_performed: { type: "boolean" },
                symbol_search_performed: { type: "boolean" },
                duplicate_check_performed: { type: "boolean" },
                candidates_reviewed: { type: "array", items: { type: "string" } },
                rejection_reasons: { type: "object" },
              },
            },
            justification: { type: "string" },
          },
          required: ["proposed_change", "search_evidence", "justification"],
        },
      },
      {
        name: "get_architecture_context",
        description: "Get architectural context for a file or namespace.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            namespace: { type: "string" },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "find_existing_behavior":
        result = await findExistingBehavior(args as Parameters<typeof findExistingBehavior>[0]);
        break;
      case "find_symbols":
        result = await findSymbols(args as Parameters<typeof findSymbols>[0]);
        break;
      case "trace_usage":
        result = await traceUsage(args as Parameters<typeof traceUsage>[0]);
        break;
      case "detect_duplicates":
        result = await detectDuplicates(args as Parameters<typeof detectDuplicates>[0]);
        break;
      case "pre_write_guard":
        result = await preWriteGuard(args as Parameters<typeof preWriteGuard>[0]);
        break;
      case "get_architecture_context":
        result = await getArchitectureContext(args as Parameters<typeof getArchitectureContext>[0]);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    logger.error({ error, tool: name }, "Tool execution failed");
    return {
      content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

// =============================================================================
// HTTP SERVER (for health checks and REST API testing)
// =============================================================================

const app = express();

// Debug logging for all requests
app.use((req: Request, _res: Response, next) => {
  logger.info({ method: req.method, path: req.path, headers: req.headers }, "Incoming request");
  next();
});

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", mode: "http+stdio" });
});

// REST API wrappers for testing
app.post("/api/tools/find_existing_behavior", async (req: Request, res: Response) => {
  try {
    const result = await findExistingBehavior(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/tools/find_symbols", async (req: Request, res: Response) => {
  try {
    const result = await findSymbols(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/tools/trace_usage", async (req: Request, res: Response) => {
  try {
    const result = await traceUsage(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/tools/detect_duplicates", async (req: Request, res: Response) => {
  try {
    const result = await detectDuplicates(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/tools/pre_write_guard", async (req: Request, res: Response) => {
  try {
    const result = await preWriteGuard(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/tools/get_architecture_context", async (req: Request, res: Response) => {
  try {
    const result = await getArchitectureContext(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// =============================================================================
// STREAMABLE HTTP TRANSPORT FOR MCP
// =============================================================================

// Store active transports and their servers
const httpTransports = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

// Create an MCP server instance with handlers
function createMcpServer(): Server {
  const mcpServer = new Server(
    { name: "codebase-brain", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "find_existing_behavior",
          description: "Search for existing code that implements a described behavior. Use BEFORE writing new code.",
          inputSchema: {
            type: "object",
            properties: {
              description: { type: "string", description: "Natural language description" },
              language: { type: "string", enum: ["csharp", "typescript", "javascript", "python"] },
              namespace: { type: "string" },
              limit: { type: "integer", default: 10 },
            },
            required: ["description", "language"],
          },
        },
        {
          name: "find_symbols",
          description: "Search for symbols by name pattern. Supports wildcards.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              language: { type: "string", default: "any" },
              symbol_type: { type: "string", default: "any" },
              limit: { type: "integer", default: 20 },
            },
            required: ["query"],
          },
        },
        {
          name: "detect_duplicates",
          description: "Check if proposed code duplicates existing functionality.",
          inputSchema: {
            type: "object",
            properties: {
              code: { type: "string" },
              description: { type: "string" },
              language: { type: "string" },
              threshold: { type: "number", default: 0.7 },
            },
            required: ["language"],
          },
        },
        {
          name: "pre_write_guard",
          description: "REQUIRED before creating new code. Validates search evidence.",
          inputSchema: {
            type: "object",
            properties: {
              proposed_change: { type: "object" },
              search_evidence: { type: "object" },
              justification: { type: "string" },
            },
            required: ["proposed_change", "search_evidence", "justification"],
          },
        },
      ],
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: unknown;
      switch (name) {
        case "find_existing_behavior":
          result = await findExistingBehavior(args as Parameters<typeof findExistingBehavior>[0]);
          break;
        case "find_symbols":
          result = await findSymbols(args as Parameters<typeof findSymbols>[0]);
          break;
        case "detect_duplicates":
          result = await detectDuplicates(args as Parameters<typeof detectDuplicates>[0]);
          break;
        case "pre_write_guard":
          result = await preWriteGuard(args as Parameters<typeof preWriteGuard>[0]);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  return mcpServer;
}

// Handle MCP requests (both GET for SSE and POST for messages)
const handleMcpRequest = async (req: Request, res: Response) => {
  const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;
  logger.info({
    method: req.method,
    path: req.path,
    accept: req.headers.accept,
    sessionId: sessionIdHeader,
    storedSessions: Array.from(httpTransports.keys()),
  }, "MCP request");

  // Ensure Accept header includes both required types for StreamableHTTPServerTransport
  const accept = req.headers.accept || "";
  if (!accept.includes("text/event-stream")) {
    req.headers.accept = accept ? `${accept}, text/event-stream` : "application/json, text/event-stream";
  }
  if (!accept.includes("application/json")) {
    req.headers.accept = `application/json, ${req.headers.accept}`;
  }

  // Check for existing session
  const sessionId = sessionIdHeader;

  if (sessionId && httpTransports.has(sessionId)) {
    // Existing session - handle the request
    const { transport } = httpTransports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session - create transport and server
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);

  // Handle the request first - session ID is generated during initialize
  await transport.handleRequest(req, res, req.body);

  // Store session AFTER handleRequest completes (session ID now available)
  const newSessionId = transport.sessionId;
  if (newSessionId) {
    httpTransports.set(newSessionId, { transport, server: mcpServer });
    logger.info({ sessionId: newSessionId }, "New MCP session created and stored");
  }

  // Clean up on close
  transport.onclose = () => {
    if (newSessionId) {
      logger.info({ sessionId: newSessionId }, "MCP session closed");
      httpTransports.delete(newSessionId);
    }
  };
};

// Register MCP endpoint for both GET and POST
app.all("/mcp", handleMcpRequest);
app.all("/sse", handleMcpRequest);

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  await initClients();

  // Start HTTP server for health checks, REST API, and SSE
  const port = parseInt(process.env.PORT || "3100");
  app.listen(port, () => {
    logger.info({ port }, "HTTP server listening (REST + SSE)");
  });

  // Start MCP stdio server (for Claude Code CLI integration)
  // Disabled by default in dev mode (TTY) to avoid blocking
  const isTTY = process.stdin.isTTY;
  const forceStdio = process.env.MCP_MODE === "stdio";

  if (forceStdio || (!isTTY && process.env.MCP_MODE !== "http-only")) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP stdio server running");
  } else {
    logger.info("Stdio disabled (TTY detected, use MCP_MODE=stdio to force)");
  }

  logger.info("Codebase Brain MCP server running");
}

main().catch((error) => {
  logger.error({ error }, "Server failed to start");
  process.exit(1);
});
