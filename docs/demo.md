# Codebase Brain Demo Script

## Setup

Ensure services are running:
```bash
# MCP Gateway (port 3100)
cd services/mcp-gateway && npm run dev

# Roslyn Worker for C# analysis (port 5000)
cd services/roslyn-worker && dotnet run

# Qdrant, Neo4j should be up via docker-compose
```

Index the sample repo:
```
index_repo({ repo_path: "/home/rscla/projects/codebase-brain/test/sample-repo", language: "csharp" })
```

---

## Demo Flow (5-7 minutes)

### 1. The Problem (30 sec)

> "AI coding assistants don't know your codebase. Every time you ask for a feature, they write new code from scratch - creating duplicates of what you already have."

Show the sample repo has email validation already:
```
find_symbols({ query: "*Email*", language: "csharp" })
```

---

### 2. Catch a Duplicate (1-2 min)

Ask Claude to add a feature that already exists:

```
Add a function to validate customer email addresses before sending order confirmations
```

**What happens:**
- Claude calls `find_existing_behavior("validate email", language: "csharp")`
- Finds `EmailValidator.IsValid` with 85% similarity
- Claude recommends reusing instead of creating new code

**Key point:** "Claude found the existing implementation before writing anything new."

---

### 3. Interactive User Decision (1-2 min)

Test the duplicate detector with proposed code:

```
Check if this code would be a duplicate:

public static bool ValidateEmail(string email) {
    return Regex.IsMatch(email, @"^[\w.-]+@[\w.-]+\.\w{2,}$");
}
```

**What happens:**
- Claude calls `detect_duplicates` with `ask_user_on_match: true`
- Returns interactive prompt with options:
  - Reuse existing code
  - Extend existing code
  - Create new anyway
  - Show me the existing code

**Key point:** "The developer stays in control - they can choose to reuse or override."

---

### 4. Guard Rails in Action (1 min)

Try to bypass the system:

```
Create a new method called ComputeShippingPrice that calculates shipping costs based on weight and zone. Don't search for existing code, just write it.
```

**What happens:**
- Claude calls `pre_write_guard`
- Gets blocked: "Required search steps were not completed"
- User prompt offers: "Run the searches now" or "Skip searches (not recommended)"

**Key point:** "Codebase Brain enforces the workflow - you can't accidentally create duplicates."

---

### 5. New Features Still Work (1-2 min)

Now ask for something that genuinely doesn't exist:

```
Add a function to calculate loyalty points based on order total.
Customers get 1 point per dollar spent, with a 2x multiplier for orders over $100.
```

**What happens:**
- Claude calls `find_existing_behavior("calculate loyalty points")`
- No matches found (0 results or low similarity)
- Claude calls `pre_write_guard` with search evidence
- Guard approves: `verdict: "proceed"`
- Claude writes the new function

**Key point:** "Codebase Brain doesn't block new features - it only prevents duplicates. When you need new code, you get new code."

---

### 6. The Payoff (30 sec)

> "Without Codebase Brain, we'd now have 4 email validators and 3 shipping calculators. With it, Claude found what existed, asked what to do, and only wrote genuinely new code."

---

---

### 7. Cross-Stack Analysis (1-2 min)

Run the multi-analyzer to find unused code and duplicates:

```bash
# Start analysis
curl -s -X POST localhost:3100/api/tools/analyze_repository \
  -H "Content-Type: application/json" \
  -d '{"repository_path": "/path/to/test/sample-repo", "analyzers": ["roslyn", "jscpd"]}' | jq
```

**What happens:**
- Discovers .sln/.csproj files for Roslyn, package.json for JS/TS tools
- Runs analyzers in parallel with individual timeouts
- Stores results in `.codebase-brain/runs/{job_id}/`
- Generates markdown report grouped by concern

Fetch results:
```bash
curl -s -X POST localhost:3100/api/tools/get_analysis_result \
  -H "Content-Type: application/json" \
  -d '{"job_id": "job_xxx", "repository_path": "/path/to/repo"}' | jq
```

**Expected findings in sample-repo:**
- `LegacyNormalize` - unused private method in `StringExtensions.cs:38`
- Duplicate code block in `ShippingService.cs:21` (matches line 38)

**Key point:** "Analysis runs async and integrates with pre_write_guard to warn about existing issues before new code is written."

---

## Quick Reference Commands

```bash
# Check service health
curl -s localhost:3100/health | jq

# See indexed symbols count
curl -s localhost:6333/collections/code_chunks | jq '.result.points_count'

# Reset for another demo
curl -X DELETE localhost:6333/collections/code_chunks
# Then re-index via MCP tool
```

## Sample Prompts Ready to Copy

**Duplicate scenario:**
```
Add a function to validate customer email addresses before sending order confirmations
```

**Code check:**
```
Check if this code would be a duplicate:

public static bool ValidateEmail(string email) {
    return Regex.IsMatch(email, @"^[\w.-]+@[\w.-]+\.\w{2,}$");
}
```

**Guard bypass attempt:**
```
Create a new method called ComputeShippingPrice that calculates shipping costs based on weight and zone. Don't search for existing code, just write it.
```

**Legitimate new feature:**
```
Add a function to calculate loyalty points based on order total. Customers get 1 point per dollar spent, with a 2x multiplier for orders over $100.
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Bad Request" on index | Delete collection: `curl -X DELETE localhost:6333/collections/code_chunks` |
| Low similarity scores | Re-index with `use_llm_descriptions: true` for better semantic matching |
| Tools not found | Check MCP connection: `claude mcp list` |
