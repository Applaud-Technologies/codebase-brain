# Codebase Brain Setup

Here’s the version I’d actually build for you: a **Linux-first, Docker-friendly “Codebase Brain”** that forces agents into **retrieve → compare → reuse → generate**, instead of letting them freehand duplicate methods. That design lines up with how Claude Code is positioned—an agentic tool that reads and works across an entire codebase—and with Sourcegraph’s emphasis that code assistants only perform well when they get the right repository context. ([Claude][1])

## What it is

Think of it as a sidecar service that sits between your repo and your AI agents. Its job is to answer four questions before any code is written:

1. **Do we already have this behavior?**
2. **What are the closest existing methods/classes?**
3. **Where are they used, and how central are they?**
4. **Is the new code about to duplicate something materially similar?**

That means the agent never starts with “write code.” It starts with “search symbols, search semantics, inspect references, score reuse candidates.” Sourcegraph explicitly describes Cody as relying on repository context, and Claude Code’s official docs describe it as understanding and operating across the codebase rather than just single-file prompting. ([Sourcegraph][2])

## The architecture I’d recommend

### 1. Indexing layer

You need three parallel indexes:

**Lexical index**

* Fast text/code search
* Best for exact names, signatures, literals, namespaces, comments

**Structural index**

* AST/symbol graph
* Best for “find all methods returning `Task<Result<T>>`” or “find all implementations of `IWhateverService`”

**Semantic index**

* Embeddings over method/class/file chunks
* Best for “find code that validates session expiry” when naming is inconsistent

This is the core lesson from tools like Sourcegraph and Tree-sitter: keyword search alone is not enough; you need code-aware structure and good context. Tree-sitter is specifically built to generate syntax trees efficiently, and Zoekt is designed as a fast code search engine for large codebases. ([GitHub][3])

### 2. Knowledge graph layer

Store relationships such as:

* method → calls → method
* class → implements → interface
* class → inherits → base class
* file → defines → symbol
* symbol → referenced by → symbol

This is where Roslyn is especially valuable in your .NET stack, because Roslyn exposes compiler-grade code analysis APIs for C# and VB. Neo4j is a solid fit if you want the graph queryable and Dockerized. ([GitHub][4])

### 3. Reuse scoring layer

When an agent asks for new code, the brain should return:

* top lexical matches
* top semantic matches
* top structural matches
* “existing usage count”
* similarity score
* recommended action: **reuse / extend / wrap / create new**

That last part is the important guardrail. If a candidate already exists and has significant references, the system should prefer extension or composition over creating a sibling helper.

### 4. Policy gate

Before any `create_method` or `write_file` action, require:

* semantic search
* symbol search
* duplicate scan
* “why existing candidates are insufficient” note

If the agent cannot justify novelty, the write is blocked or downgraded to a human-review suggestion.

---

## The concrete Linux/Docker stack

This is the stack I’d use for **your environment**.

### Recommended core stack

* **Zoekt** for fast code search. It is open source and designed for code search on standard Linux machines. ([GitHub][5])
* **Tree-sitter** for language parsing / AST extraction. It is open source and explicitly built for incremental syntax trees. ([GitHub][3])
* **Roslyn** for C# symbol/index/reference analysis. It is the .NET compiler platform with rich code analysis APIs. ([GitHub][4])
* **Qdrant** for vector search. The official quickstart is Docker-based. ([Qdrant][6])
* **Neo4j** for code graph storage. Neo4j documents Docker deployment and self-managed local/cloud options. ([Graph Database & Analytics][7])
* **Semgrep** for rule-based duplicate/anti-pattern/security checks. Semgrep provides official Docker images and Linux Docker instructions. ([Semgrep][8])

### Optional outer-layer tools

* **Continue** if you want IDE/PR workflow integration with agents and checks. Continue offers VS Code and JetBrains installs and paid team/company tiers. ([Continue Docs][9])
* **Aider** if you want a terminal-native agent interface; it has official Docker images. ([Aider][10])
* **Sourcegraph** if you want a commercial code intelligence/search layer instead of assembling everything yourself. Sourcegraph now advertises Deep Search, Code Search, and an MCP server on its platform, with pricing on its official page. ([Sourcegraph][11])
* **Cursor** if you want an editor-native agent, though it is not Docker-first; its pricing is current on the official site. ([Cursor][12])

---

## Current pricing and Linux/Docker fit

Here’s the cleanest current snapshot from official sources.

| Tool                          |                                                                                     Price | Linux/Docker fit                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------ |
| Tree-sitter                   |                                                                                Free / OSS | Linux-friendly library/tooling; no Docker requirement. ([GitHub][3])                                         |
| Zoekt                         |                                                                                Free / OSS | Built for standard Linux machine usage. ([GitHub][5])                                                        |
| Roslyn                        |                                                                                Free / OSS | .NET analysis APIs; ideal for your C# stack. ([GitHub][4])                                                   |
| Universal Ctags               |                                                                                Free / OSS | Linux-friendly; active maintained project. ([ctags.io][13])                                                  |
| Qdrant                        |                                                            Free / OSS local; cloud varies | Official docs explicitly support local Docker. ([Qdrant][6])                                                 |
| Neo4j                         |                                                    Community available; enterprise varies | Official Docker support. ([Graph Database & Analytics][7])                                                   |
| Semgrep                       |    Free up to 10 contributors; Teams starting at $30/contributor/month; Enterprise custom | Official Docker image and Linux Docker workflow. ([Semgrep][14])                                             |
| Continue                      |          Starter $3/million tokens; Team $20/seat/month incl. $10 credits; Company custom | IDE-centric, not Docker-native, but Linux-friendly through VS Code/JetBrains workflows. ([continue.dev][15]) |
| Aider                         |                                                          Free / OSS; model costs separate | Official Docker images available. ([Aider][10])                                                              |
| Cursor                        |  Hobby free; Pro $20/mo; Pro+ $60/mo; Ultra $200/mo; Teams $40/user/mo; Enterprise custom | Linux app/editor workflow, but not really a Dockerized backend tool. ([Cursor][12])                          |
| Sourcegraph Enterprise Search |                                                    $49/user/month on current pricing page | Commercial platform; cloud/self-managed options vary by contract. ([Sourcegraph][11])                        |
| CodeQL                        | Free for research and open source; enterprise use typically via GitHub security licensing | CLI-based, Linux-friendly analysis model. ([codeql.github.com][16])                                          |

## My recommendation for you

Because you want **Linux or Docker**, I would not make Cursor or a hosted IDE the foundation. I’d treat those as optional clients.

I’d build the brain around this:

* **Zoekt**
* **Tree-sitter**
* **Roslyn worker**
* **Qdrant**
* **Neo4j**
* **Semgrep**
* thin **API/MCP gateway**

That gives you a fully local-ish, Dockerable backend with strong .NET awareness and agent-ready retrieval.

---

## The API surface I’d expose to agents

Your MCP/API should offer at least these tools:

### `find_existing_behavior`

Input:

* natural language task
* language
* optional architecture area

Output:

* top 10 candidate methods/classes
* similarity score
* file path
* signature
* usage count
* recommendation: reuse / extend / wrap / new

### `find_symbols`

Input:

* interface/class/method name
* filters like return type, namespace, modifiers

Output:

* matching symbols
* implementations
* references

### `trace_usage`

Input:

* symbol id

Output:

* callers
* callees
* dependency fan-in / fan-out
* test coverage presence if available

### `detect_duplicates`

Input:

* proposed method body or method summary

Output:

* likely duplicates
* overlap rationale
* exact/near/semantic duplicate classification

### `pre_write_guard`

Input:

* requested change

Output:

* pass/fail
* evidence package
* missing analysis steps

This is the part most agent stacks are missing. They have search, but they do not have a **hard gate** before generation.

---

## The ranking strategy

I would score reuse candidates roughly like this:

**ReuseScore =**

* 30% semantic similarity
* 25% symbol/signature fit
* 20% lexical match
* 15% centrality/usage count
* 10% architecture locality

Then apply penalties for:

* deprecated code
* test-only utilities when production code is requested
* low-confidence generated code
* old or isolated orphan code

For your repos, architecture locality matters a lot. A method in the correct vertical slice or bounded context should beat a “kind of similar” helper somewhere else.

---

## The deduplication policy I’d enforce

For any agent write:

1. Search top 20 semantic candidates
2. Search top 20 lexical/symbol candidates
3. Read top 5 by combined score
4. Compare signatures and behavior
5. Decide one of:

   * reuse directly
   * extend existing
   * create wrapper/facade
   * create new, with justification

And I’d require the agent to log:

* which candidates it inspected
* why they were insufficient
* why a new method is warranted

That audit trail alone will cut a lot of code bloat.

---

## What commercial products already do part of this

I would be careful not to overstate internal vendor architectures. I can verify that:

* **Claude Code** is built around codebase-wide understanding and tool use across files and commands. ([Claude][1])
* **Sourcegraph** explicitly frames Cody/Deep Search around repository context, code search, symbol search, and code understanding. ([Sourcegraph][2])

I cannot verify a full “Anthropic internal code knowledge graph architecture” from public docs, so I would treat that part as an implementation inference rather than a published fact.

---

## Best fit for Applaud-style usage

For your kind of work—large .NET codebases, multiple agents, structured architecture, and a desire to keep repos clean—I’d split it this way:

* **Backend intelligence**: Zoekt + Tree-sitter + Roslyn + Qdrant + Neo4j + Semgrep
* **Agent interface**: Claude Code or Aider
* **Optional enterprise augmentation**: Sourcegraph

That keeps your real IP and search/ranking logic in a system you control, while letting the front-end agent be swappable.

---

## A phased rollout

### Phase 1

Build lexical + Roslyn symbol search only.
You’ll get immediate value with low complexity.

### Phase 2

Add Qdrant embeddings and semantic search.
This is where duplicate prevention gets materially better.

### Phase 3

Add Neo4j call graph and architecture locality scoring.
Now the system starts making genuinely smart reuse recommendations.

### Phase 4

Add hard pre-write gating for agents.
That’s when code bloat drops.

---

## My blunt recommendation

If you want the **most practical, lowest-regret path**:

* start with **Roslyn + Zoekt + Qdrant**
* add **Semgrep** for rule-driven enforcement
* add **Neo4j** only once you want richer architectural reasoning

That gives you an 80/20 win without overbuilding.

If you want, next I can turn this into a **real implementation blueprint** with:

* Docker Compose services
* MCP tool definitions
* index schemas
* ranking formula
* an agent prompt contract for “search before write”

[1]: https://code.claude.com/docs/en/overview "Claude Code overview - Claude Code Docs"
[2]: https://sourcegraph.com/blog/how-cody-understands-your-codebase "How Cody understands your codebase | Sourcegraph Blog"
[3]: https://github.com/tree-sitter/tree-sitter?utm_source=chatgpt.com "Tree-sitter"
[4]: https://github.com/dotnet/roslyn?utm_source=chatgpt.com "The Roslyn .NET compiler provides C# and Visual Basic ..."
[5]: https://github.com/sourcegraph/zoekt?utm_source=chatgpt.com "sourcegraph/zoekt: Fast trigram based code search"
[6]: https://qdrant.tech/documentation/quickstart/ "Qdrant Quickstart"
[7]: https://neo4j.com/docs/operations-manual/current/docker/?utm_source=chatgpt.com "Docker - Operations Manual"
[8]: https://semgrep.dev/docs/getting-started/quickstart "Quickstart | Semgrep"
[9]: https://docs.continue.dev/ide-extensions/install?utm_source=chatgpt.com "Install"
[10]: https://aider.chat/docs/install/docker.html?utm_source=chatgpt.com "Aider with docker"
[11]: https://sourcegraph.com/pricing "Sourcegraph | Pricing"
[12]: https://cursor.com/pricing "Cursor · Pricing"
[13]: https://ctags.io/?utm_source=chatgpt.com "Home · Universal Ctags"
[14]: https://semgrep.dev/pricing "Pricing and Plans | AppSec Platform SAST, SCA, and Secrets | Semgrep"
[15]: https://www.continue.dev/pricing "Continue • Pricing"
[16]: https://codeql.github.com/?utm_source=chatgpt.com "CodeQL"
