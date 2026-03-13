# Testing Codebase Brain

This guide walks through testing each component of Codebase Brain.

## Quick Test

```bash
./test/test-system.sh
```

## Sample Repository

The `test/sample-repo/` contains intentional duplicates for testing:

| File | Method | Duplicate Of |
|------|--------|--------------|
| `StringExtensions.cs` | `IsValidEmail()` | `EmailValidator.IsValid()` |
| `OrderHelpers.cs` | `GenerateSlug()` | `StringExtensions.ToSlug()` |
| `OrderHelpers.cs` | `ComputeShippingCost()` | `ShippingService.CalculateDomesticShipping()` |

## Phase-by-Phase Testing

### Phase 1: Infrastructure Only

Start the databases without the application services:

```bash
cd ~/projects/codebase-brain
docker compose up -d qdrant neo4j
```

Verify:
```bash
# Qdrant health
curl http://localhost:6333/readyz
# Expected: {"status":"ok"}

# Neo4j browser (open in browser)
open http://localhost:7474
# Login: neo4j / codebase-brain-dev
```

### Phase 2: Embedding Pipeline

Test that Ollama can generate embeddings:

```bash
# Single embedding
curl http://localhost:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"validate email address"}'

# Check dimensions (should be 384 for all-minilm)
curl -s http://localhost:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"test"}' | jq '.embedding | length'
```

### Phase 3: Manual Qdrant Test

Insert and search vectors directly:

```bash
# Create collection
curl -X PUT http://localhost:6333/collections/test_code \
  -H "Content-Type: application/json" \
  -d '{
    "vectors": {
      "size": 384,
      "distance": "Cosine"
    }
  }'

# Get embedding for "validate email"
EMBEDDING=$(curl -s http://localhost:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"validate email address format"}' \
  | jq -c '.embedding')

# Insert point
curl -X PUT http://localhost:6333/collections/test_code/points \
  -H "Content-Type: application/json" \
  -d "{
    \"points\": [{
      \"id\": 1,
      \"vector\": $EMBEDDING,
      \"payload\": {
        \"name\": \"EmailValidator.IsValid\",
        \"file\": \"EmailValidator.cs\"
      }
    }]
  }"

# Search for similar
QUERY=$(curl -s http://localhost:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"check if email is valid"}' \
  | jq -c '.embedding')

curl -X POST http://localhost:6333/collections/test_code/points/search \
  -H "Content-Type: application/json" \
  -d "{
    \"vector\": $QUERY,
    \"limit\": 5,
    \"with_payload\": true
  }"
```

### Phase 4: Manual Neo4j Test

Create and query the code graph:

```cypher
// Connect to Neo4j browser at http://localhost:7474

// Create test nodes
CREATE (e:Symbol {
  id: 'email-validator-isvalid',
  name: 'IsValid',
  qualified_name: 'SampleApp.Validation.EmailValidator.IsValid',
  symbol_type: 'method',
  language: 'csharp'
})

CREATE (s:Symbol {
  id: 'string-ext-isvalidemail',
  name: 'IsValidEmail',
  qualified_name: 'SampleApp.Extensions.StringExtensions.IsValidEmail',
  symbol_type: 'method',
  language: 'csharp'
})

// Mark as similar
CREATE (e)-[:SIMILAR_TO {score: 0.95}]->(s)

// Query for duplicates
MATCH (s1:Symbol)-[r:SIMILAR_TO]->(s2:Symbol)
WHERE r.score > 0.8
RETURN s1.name, s2.name, r.score
```

### Phase 5: MCP Gateway

Build and run the gateway:

```bash
cd ~/projects/codebase-brain/services/mcp-gateway
npm install
npm run dev
```

Test the API:

```bash
# Health check
curl http://localhost:3100/health

# Find existing behavior
curl -X POST http://localhost:3100/api/tools/find_existing_behavior \
  -H "Content-Type: application/json" \
  -d '{
    "description": "validate email address format",
    "language": "csharp"
  }'

# Find symbols
curl -X POST http://localhost:3100/api/tools/find_symbols \
  -H "Content-Type: application/json" \
  -d '{
    "query": "IsValid*",
    "language": "csharp",
    "symbol_type": "method"
  }'

# Detect duplicates
curl -X POST http://localhost:3100/api/tools/detect_duplicates \
  -H "Content-Type: application/json" \
  -d '{
    "code": "public static bool ValidateEmail(string email) { return Regex.IsMatch(email, @\"^[\\w.-]+@[\\w.-]+\\.\\w{2,}$\"); }",
    "language": "csharp",
    "threshold": 0.7
  }'

# Pre-write guard (should fail - no searches performed)
curl -X POST http://localhost:3100/api/tools/pre_write_guard \
  -H "Content-Type: application/json" \
  -d '{
    "proposed_change": {
      "type": "new_method",
      "name": "CheckEmail",
      "description": "Validate email format"
    },
    "search_evidence": {
      "behavior_search_performed": false,
      "symbol_search_performed": false,
      "duplicate_check_performed": false
    },
    "justification": ""
  }'
```

### Phase 6: Claude Code Integration

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

Then in Claude Code, try:

```
You: Add a method to validate email addresses

Claude: (should call find_existing_behavior first)
```

### Phase 7: End-to-End Duplicate Detection

The ultimate test - ask Claude Code to add functionality that already exists:

```
You: Add a helper method to generate URL slugs from titles

Expected behavior:
1. Claude calls find_existing_behavior("generate URL slug from text")
2. Finds StringExtensions.ToSlug and OrderHelpers.GenerateSlug
3. Recommends reusing StringExtensions.ToSlug instead of creating new
```

## Debugging

### Check Qdrant Collections

```bash
curl http://localhost:6333/collections
curl http://localhost:6333/collections/code_chunks
curl http://localhost:6333/collections/code_chunks/points/count
```

### Check Neo4j Data

```cypher
// Count nodes
MATCH (n) RETURN labels(n), count(n)

// Check recent symbols
MATCH (s:Symbol) RETURN s.name, s.qualified_name LIMIT 10
```

### Check Indexer Logs

```bash
docker compose logs -f indexer
```

### Check MCP Gateway Logs

```bash
docker compose logs -f mcp-gateway
# Or if running locally:
# LOG_LEVEL=debug npm run dev
```

## Expected Results

When working correctly:

1. **find_existing_behavior("validate email")** should return:
   - `EmailValidator.IsValid` (similarity ~0.9)
   - `StringExtensions.IsValidEmail` (similarity ~0.85)

2. **detect_duplicates** with email validation code should:
   - Flag as "exact" or "near" duplicate
   - Recommend "reuse_existing"

3. **pre_write_guard** without search evidence should:
   - Return `verdict: "blocked"`
   - List missing steps

4. **pre_write_guard** with proper evidence should:
   - Return `verdict: "proceed"` or `"needs_human_review"`
