# Codebase Brain

A code intelligence sidecar that enforces **retrieve → compare → reuse → generate** for AI agents. Prevents code duplication by requiring agents to search for existing functionality before creating new code.

This design aligns with how [Claude Code][1] is positioned—an agentic tool that reads and works across an entire codebase—and with [Sourcegraph's emphasis][2] that code assistants only perform well when they get the right repository context.

## Quick Start

```bash
# 1. Copy environment file
cp .env.example .env

# 2. Pull Ollama embedding model
ollama pull all-minilm  # Fast, for development
# OR
ollama pull mxbai-embed-large  # Best quality, for production

# 3. Start services
docker compose up -d

# 4. Configure Claude Code (add to ~/.claude/settings.json)
# See config/claude-code-mcp.json for the configuration
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Claude Code                                 │
│                          (with MCP integration)                          │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           MCP Gateway (:3100)                            │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────────────┐│
│  │find_existing_   │ │  find_symbols   │ │     pre_write_guard         ││
│  │behavior         │ │                 │ │   (blocks without search)   ││
│  └────────┬────────┘ └────────┬────────┘ └─────────────┬───────────────┘│
│           │                   │                        │                 │
│  ┌────────┴───────────────────┴────────────────────────┴───────────────┐│
│  │                        Scoring & Ranking                             ││
│  │              (semantic + lexical + centrality + locality)            ││
│  └──────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Qdrant (:6333) │       │ Neo4j (:7474)   │       │  Zoekt (:6070)  │
│                 │       │                 │       │                 │
│ Semantic Search │       │   Code Graph    │       │ Lexical Search  │
│  (embeddings)   │       │ (calls, types)  │       │  (text/names)   │
└────────┬────────┘       └────────┬────────┘       └────────┬────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              Indexer                                     │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────────────┐│
│  │  Tree-sitter    │ │ Roslyn Worker   │ │       File Watcher          ││
│  │ (TS/JS/Python)  │ │ (.NET analysis) │ │   (incremental updates)     ││
│  └─────────────────┘ └─────────────────┘ └─────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                        ┌─────────────────┐
                        │   Your Repos    │
                        │  (/repos mount) │
                        └─────────────────┘
```

## Core Stack

| Component | Purpose | Source |
|-----------|---------|--------|
| [Zoekt][5] | Fast trigram-based code search | Sourcegraph |
| [Tree-sitter][3] | Incremental parsing for AST extraction | GitHub |
| [Roslyn][4] | .NET compiler platform for C# analysis | Microsoft |
| [Qdrant][6] | Vector database for semantic search | Qdrant |
| [Neo4j][7] | Graph database for code relationships | Neo4j |
| [Semgrep][8] | Rule-based code analysis | Semgrep |

## Embedding Models

Benchmarked on RTX 3070 (8GB VRAM):

| Model | Speed | Size | Dimensions | MTEB Score | Use Case |
|-------|-------|------|------------|------------|----------|
| [all-minilm][17] | 79ms | 45MB | 384 | ~54 | Development (default) |
| [nomic-embed-text][18] | 118ms | 274MB | 768 | 62.4 | Balanced |
| [mxbai-embed-large][19] | 122ms | 670MB | 1024 | 64.7 | Production |

Set via environment variables:
```bash
EMBEDDING_MODEL=mxbai-embed-large
EMBEDDING_DIMENSIONS=1024
```

## Directory Structure

```
codebase-brain/
├── docker-compose.yml          # All services orchestration
├── .env.example                # Environment configuration
├── config/
│   ├── ranking.yaml            # Scoring weights and thresholds
│   ├── claude-code-mcp.json    # Claude Code integration config
│   └── zoekt/                  # Zoekt indexer configuration
├── schemas/
│   ├── mcp-tools.json          # MCP tool definitions
│   ├── qdrant-collections.json # Vector DB schemas
│   └── neo4j-schema.cypher     # Graph DB schema
├── services/
│   ├── mcp-gateway/            # TypeScript MCP server
│   ├── indexer/                # Python code indexer
│   └── roslyn-worker/          # .NET analysis service
├── hooks/
│   └── pre-write-guard.sh      # Claude Code hook script
└── docs/
    └── agent-contract.md       # Agent behavioral requirements
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `find_existing_behavior` | Semantic search for code that does what you need |
| `find_symbols` | Search symbols by name/pattern with wildcards |
| `trace_usage` | Get callers, callees, and centrality metrics |
| `detect_duplicates` | Check if proposed code duplicates existing |
| `pre_write_guard` | **Gate** - validates search evidence before writes |
| `get_architecture_context` | Get layer, dependencies, and patterns for a location |

## The Pre-Write Guard

The key innovation is the `pre_write_guard` tool. Before any new code creation:

1. Agent **must** call `find_existing_behavior` with what they need
2. Agent **must** call `find_symbols` to check for similar names
3. Agent **must** review candidates and explain why they're insufficient
4. Agent **must** call `pre_write_guard` with evidence

If evidence is missing, the guard blocks the write.

## Ranking Formula

Candidates are scored using:

```
ReuseScore =
    30% × semantic_similarity +
    25% × signature_fit +
    20% × lexical_match +
    15% × centrality +
    10% × architecture_locality
```

With penalties for:
- Deprecated code (0.3x)
- Test-only utilities (0.2x)
- Generated code (0.4x)
- Orphan code with few references (0.5x)

And bonuses for:
- Same namespace (1.2x)
- Recent activity (1.1x)
- Well-documented (1.1x)

## Phased Implementation

### Phase 1: Core Search (Start Here)
- Zoekt for lexical search
- Roslyn worker for .NET symbol extraction
- Basic MCP gateway with `find_symbols` and `find_existing_behavior`

### Phase 2: Semantic Intelligence
- Qdrant for embeddings
- `detect_duplicates` tool
- Ranking with semantic similarity

### Phase 3: Graph Intelligence
- Neo4j for call graphs
- `trace_usage` tool
- Centrality-based scoring

### Phase 4: Enforcement
- `pre_write_guard` tool
- Claude Code hook integration
- Audit logging

## Configuration

### Claude Code Integration

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "codebase-brain": {
      "type": "sse",
      "url": "http://localhost:3100/sse"
    }
  }
}
```

Or use stdio mode (see `config/claude-code-mcp.json`).

### Hook Installation

Add to `.claude/settings.json` in your project:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "/path/to/codebase-brain/hooks/pre-write-guard.sh"
      }]
    }]
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REPOS_ROOT` | `/home/rscla/repos` | Path to repositories to index |
| `NEO4J_PASSWORD` | `codebase-brain-dev` | Neo4j password |
| `EMBEDDING_MODEL` | `all-minilm` | Ollama embedding model |
| `EMBEDDING_DIMENSIONS` | `384` | Must match model (384/768/1024) |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama API URL |
| `BLOCK_ON_FAILURE` | `false` | Block writes on guard failure |
| `LOG_LEVEL` | `info` | Logging verbosity |

## Development

```bash
# Run just the infrastructure
docker compose up -d zoekt qdrant neo4j

# Run MCP gateway in dev mode
cd services/mcp-gateway
npm install
npm run dev

# Run indexer
cd services/indexer
pip install -r requirements.txt
python -m indexer
```

## Pricing Reference

| Tool | Price | Notes |
|------|-------|-------|
| [Tree-sitter][3] | Free / OSS | Core parsing library |
| [Zoekt][5] | Free / OSS | Code search engine |
| [Roslyn][4] | Free / OSS | .NET compiler platform |
| [Universal Ctags][13] | Free / OSS | Tag generation |
| [Qdrant][6] | Free local; cloud varies | Vector database |
| [Neo4j][7] | Community free; enterprise varies | Graph database |
| [Semgrep][14] | Free <10 contributors; Teams $30/user/mo | Code analysis |
| [Continue][15] | Starter $3/M tokens; Team $20/seat/mo | IDE integration |
| [Aider][10] | Free / OSS; model costs separate | Terminal agent |
| [Cursor][12] | Free-$200/mo tiers | AI editor |
| [Sourcegraph][11] | $49/user/month | Enterprise code search |
| [CodeQL][16] | Free for OSS | Security analysis |

## Alternative Agent Interfaces

While Codebase Brain is designed as a backend, you can connect it to various agent frontends:

- **[Claude Code][1]** - Native integration via MCP (recommended)
- **[Aider][10]** - Terminal-native with Docker support
- **[Continue][9]** - VS Code / JetBrains integration
- **[Sourcegraph Cody][2]** - Enterprise code intelligence

## License

MIT

## References

### Core Technologies
- [1]: https://claude.ai/code "Claude Code - Anthropic"
- [2]: https://sourcegraph.com/blog/how-cody-understands-your-codebase "How Cody understands your codebase"
- [3]: https://github.com/tree-sitter/tree-sitter "Tree-sitter - Incremental parsing"
- [4]: https://github.com/dotnet/roslyn "Roslyn - .NET Compiler Platform"
- [5]: https://github.com/sourcegraph/zoekt "Zoekt - Fast code search"
- [6]: https://qdrant.tech/documentation/quickstart/ "Qdrant Quickstart"
- [7]: https://neo4j.com/docs/operations-manual/current/docker/ "Neo4j Docker"
- [8]: https://semgrep.dev/docs/getting-started/quickstart "Semgrep Quickstart"

### Agent Tools
- [9]: https://docs.continue.dev/ide-extensions/install "Continue IDE Extensions"
- [10]: https://aider.chat/docs/install/docker.html "Aider Docker Install"

### Pricing
- [11]: https://sourcegraph.com/pricing "Sourcegraph Pricing"
- [12]: https://cursor.com/pricing "Cursor Pricing"
- [13]: https://ctags.io/ "Universal Ctags"
- [14]: https://semgrep.dev/pricing "Semgrep Pricing"
- [15]: https://www.continue.dev/pricing "Continue Pricing"
- [16]: https://codeql.github.com/ "CodeQL"

### Embedding Models
- [17]: https://ollama.com/library/all-minilm "all-minilm on Ollama"
- [18]: https://ollama.com/library/nomic-embed-text "nomic-embed-text on Ollama"
- [19]: https://ollama.com/library/mxbai-embed-large "mxbai-embed-large on Ollama"
- [20]: https://ollama.com/blog/embedding-models "Ollama Embedding Models"
- [21]: https://www.arsturn.com/blog/picking-the-perfect-partner-a-guide-to-choosing-the-best-embedding-models-in-ollama "Ollama Embedding Model Guide"

[1]: https://claude.ai/code
[2]: https://sourcegraph.com/blog/how-cody-understands-your-codebase
[3]: https://github.com/tree-sitter/tree-sitter
[4]: https://github.com/dotnet/roslyn
[5]: https://github.com/sourcegraph/zoekt
[6]: https://qdrant.tech/documentation/quickstart/
[7]: https://neo4j.com/docs/operations-manual/current/docker/
[8]: https://semgrep.dev/docs/getting-started/quickstart
[9]: https://docs.continue.dev/ide-extensions/install
[10]: https://aider.chat/docs/install/docker.html
[11]: https://sourcegraph.com/pricing
[12]: https://cursor.com/pricing
[13]: https://ctags.io/
[14]: https://semgrep.dev/pricing
[15]: https://www.continue.dev/pricing
[16]: https://codeql.github.com/
[17]: https://ollama.com/library/all-minilm
[18]: https://ollama.com/library/nomic-embed-text
[19]: https://ollama.com/library/mxbai-embed-large
[20]: https://ollama.com/blog/embedding-models
[21]: https://www.arsturn.com/blog/picking-the-perfect-partner-a-guide-to-choosing-the-best-embedding-models-in-ollama
