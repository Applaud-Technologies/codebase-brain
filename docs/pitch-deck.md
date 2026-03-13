# Codebase Brain
## Pitch Deck

---

## Slide 1: Title

# Codebase Brain

**AI Code Intelligence That Prevents Duplication**

*Search before write — for AI coding assistants*

---

## Slide 2: The Problem

### AI coding assistants don't know your codebase

Every time you ask AI to add a feature:
- It generates **new code** from scratch
- It **doesn't search** for existing implementations
- It creates **duplicates** of code you already have

**Result:** Technical debt compounds with every AI-assisted session

> "Add email validation" → AI writes new method → You now have 4 email validators

---

## Slide 3: The Scale of the Problem

### Code duplication is everywhere

| Metric | Industry Average |
|--------|------------------|
| Duplicate code in enterprise codebases | 15-30% |
| Developer time spent on redundant features | 20% |
| Bugs introduced by inconsistent implementations | 35% of total bugs |

**AI is accelerating this problem, not solving it.**

---

## Slide 4: The Solution

### Codebase Brain

A sidecar service that enforces **search-before-write** for AI coding assistants

```
Search → Compare → Reuse → Generate
```

Before AI writes new code, it must:
1. Search for existing implementations
2. Compare proposed code against what exists
3. Get approval from a "pre-write guard"

**If matching code exists, AI recommends reuse instead of duplication.**

---

## Slide 5: Demo - Before & After

### Without Codebase Brain

```
You: "Add a method to calculate shipping costs"
AI: *immediately writes new CalculateShipping() method*
Result: Duplicate of 3 existing shipping methods
```

### With Codebase Brain

```
You: "Add a method to calculate shipping costs"
AI: *calls find_existing_behavior("calculate shipping")*
AI: "Found ComputeShippingCost() and CalculateDomesticShipping()
     with 92% similarity. Recommend reusing existing methods."
```

---

## Slide 6: How It Works

### Three-layer code intelligence

```
┌─────────────────┐                    ┌─────────────────┐
│   Claude Code   │◄──── MCP ─────────►│  Codebase Brain │
└─────────────────┘                    └────────┬────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    ▼                           ▼                           ▼
              ┌──────────┐                ┌──────────┐                ┌──────────┐
              │  Qdrant  │                │  Neo4j   │                │  Zoekt   │
              │ Semantic │                │   Code   │                │ Lexical  │
              └──────────┘                └──────────┘                └──────────┘
```

- **Semantic:** Understands what code *does*, not just what it's named
- **Structural:** Tracks calls, dependencies, and relationships
- **Lexical:** Fast exact-match pattern search

---

## Slide 7: The Four Tools

### MCP Tools for Claude Code

| Tool | Purpose |
|------|---------|
| `find_existing_behavior` | Semantic search: "calculate shipping cost" |
| `find_symbols` | Pattern search: `*Shipping*` |
| `detect_duplicates` | Check if proposed code is duplicate |
| `pre_write_guard` | Block writes without search evidence |

**The pre_write_guard is the enforcement mechanism** — it requires proof that existing code was checked.

---

## Slide 8: Key Differentiators

### Why Codebase Brain wins

| Feature | Traditional Search | Codebase Brain |
|---------|-------------------|----------------|
| Understands behavior | ❌ | ✅ Semantic embeddings |
| Enforces workflow | ❌ | ✅ Pre-write guard |
| Works with AI assistants | ❌ | ✅ MCP protocol |
| Self-hosted | Varies | ✅ Your infrastructure |
| Real-time indexing | ❌ | ✅ Continuous updates |

---

## Slide 9: Market Opportunity

### AI-assisted coding is exploding

- **92%** of developers now use AI coding tools (GitHub 2025)
- **$10B+** market for AI developer tools by 2027
- **40%** of code in new projects is AI-generated

**Every AI-generated line of code is a potential duplicate.**

Codebase Brain is infrastructure for responsible AI coding.

---

## Slide 10: Business Model

### Open core + Enterprise

**Open Source (Free)**
- Core MCP server
- Basic indexing (semantic + lexical)
- Single repo support

**Enterprise (Paid)**
- Multi-repo federated search
- SSO / RBAC integration
- Priority indexing for large codebases
- Custom ranking algorithms
- SLA support

---

## Slide 11: Traction / Roadmap

### Current Status

- ✅ Working MCP server for Claude Code
- ✅ Semantic search (Qdrant + embeddings)
- ✅ Code graph (Neo4j)
- ✅ Pre-write guard enforcement
- ✅ Docker Compose deployment

### Roadmap

- Q2: VS Code extension
- Q3: GitHub integration (PR review bot)
- Q4: Multi-repo support
- 2027: IDE-native plugins (JetBrains, etc.)

---

## Slide 12: Team

### [Your Name]

*Background, relevant experience*

**Advisors:**
- [Names if applicable]

---

## Slide 13: Ask

### What we're looking for

**Seed Round:** $X

**Use of Funds:**
- Engineering (multi-repo, IDE plugins)
- Community building
- Enterprise pilot programs

---

## Slide 14: Quick Start

### Try it in 2 minutes

```bash
# Start Codebase Brain
git clone https://github.com/Applaud-Technologies/codebase-brain
cd codebase-brain && docker compose up -d

# Connect Claude Code
claude mcp add codebase-brain --type http --url http://localhost:3100/mcp

# Start coding — AI will search before it writes
```

**[Applaud-Technologies.github.io/codebase-brain](https://Applaud-Technologies.github.io/codebase-brain)**

---

## Slide 15: Contact

### Let's talk

**Email:** your@email.com
**GitHub:** github.com/Applaud-Technologies/codebase-brain
**Demo:** [Schedule a call]

---

# Appendix

---

## A1: Technical Architecture Detail

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Gateway (Node.js)                    │
│  ┌─────────────────┬─────────────────┬─────────────────┐        │
│  │ find_existing   │ find_symbols    │ pre_write_guard │        │
│  │ _behavior       │                 │                 │        │
│  └────────┬────────┴────────┬────────┴────────┬────────┘        │
│           │                 │                 │                 │
│  ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼───────┐          │
│  │ Embedding       │ │   Scorer    │ │   Session     │          │
│  │ Service         │ │             │ │   Manager     │          │
│  │ (Ollama)        │ │             │ │               │          │
│  └────────┬────────┘ └──────┬──────┘ └───────────────┘          │
└───────────┼─────────────────┼───────────────────────────────────┘
            │                 │
   ┌────────▼────────┐ ┌──────▼──────┐ ┌─────────────────┐
   │     Qdrant      │ │   Neo4j     │ │     Zoekt       │
   │  (Vectors)      │ │  (Graph)    │ │   (Lexical)     │
   │  384-dim        │ │  Cypher     │ │   Trigram       │
   └─────────────────┘ └─────────────┘ └─────────────────┘
```

---

## A2: Ranking Formula

Candidate relevance is scored using weighted combination:

```
score = (0.30 × semantic_similarity)
      + (0.25 × signature_match)
      + (0.20 × lexical_overlap)
      + (0.15 × graph_centrality)
      + (0.10 × file_locality)
```

**Thresholds:**
- ≥ 0.85: "Exact duplicate" → Block
- 0.70-0.85: "Near duplicate" → Strong reuse recommendation
- 0.50-0.70: "Similar" → Suggest review
- < 0.50: "New code warranted"

---

## A3: Competitive Landscape

| Product | Focus | Limitation |
|---------|-------|------------|
| GitHub Copilot | Code generation | No duplicate detection |
| Sourcegraph | Code search | Not AI-integrated |
| Codex/CodeWhisperer | Generation | No codebase awareness |
| **Codebase Brain** | **Prevention** | **Enforces workflow** |

We're not competing with AI coding assistants — we're **augmenting them**.

---

## A4: Security & Privacy

- **Self-hosted:** Code never leaves your infrastructure
- **Local embeddings:** Ollama runs on your hardware
- **No external API calls:** All processing is internal
- **Docker isolation:** Each service in separate container
- **Enterprise:** Air-gapped deployment option
