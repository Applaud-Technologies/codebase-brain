#!/usr/bin/env bash
# =============================================================================
# CODEBASE BRAIN - SYSTEM TEST SCRIPT
# =============================================================================
# Run this to verify all components are working correctly.
#
# Usage: ./test/test-system.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
info() { echo -e "  $1"; }

echo "============================================="
echo "Codebase Brain System Test"
echo "============================================="
echo ""

# -----------------------------------------------------------------------------
# Phase 1: Check Prerequisites
# -----------------------------------------------------------------------------
echo "Phase 1: Prerequisites"
echo "---------------------------------------------"

# Check Docker
if command -v docker &> /dev/null; then
    pass "Docker installed"
else
    fail "Docker not found"
fi

# Check Ollama
if curl -s http://localhost:11434/api/tags &> /dev/null; then
    pass "Ollama running"
else
    fail "Ollama not running (start with: ollama serve)"
fi

# Check embedding model
MODELS=$(curl -s http://localhost:11434/api/tags | jq -r '.models[].name' 2>/dev/null || echo "")
if echo "$MODELS" | grep -q "all-minilm\|nomic-embed\|mxbai-embed"; then
    pass "Embedding model available"
else
    warn "No embedding model found (run: ollama pull all-minilm)"
fi

echo ""

# -----------------------------------------------------------------------------
# Phase 2: Test Embedding Pipeline
# -----------------------------------------------------------------------------
echo "Phase 2: Embedding Pipeline"
echo "---------------------------------------------"

# Test embedding generation
EMBED_RESULT=$(curl -s http://localhost:11434/api/embeddings \
    -d '{"model":"all-minilm","prompt":"calculate shipping cost based on weight"}' 2>/dev/null)

if echo "$EMBED_RESULT" | jq -e '.embedding | length > 0' &> /dev/null; then
    DIMS=$(echo "$EMBED_RESULT" | jq '.embedding | length')
    pass "Embedding generated ($DIMS dimensions)"
else
    fail "Embedding generation failed"
fi

# Benchmark embedding speed
echo -n "  Benchmarking... "
START=$(date +%s%N)
for i in {1..5}; do
    curl -s http://localhost:11434/api/embeddings \
        -d '{"model":"all-minilm","prompt":"test embedding speed"}' > /dev/null
done
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 / 5 ))
echo "${ELAPSED}ms per embedding"

echo ""

# -----------------------------------------------------------------------------
# Phase 3: Test Infrastructure (if running)
# -----------------------------------------------------------------------------
echo "Phase 3: Infrastructure Services"
echo "---------------------------------------------"

# Check Qdrant
if curl -s http://localhost:6333/readyz &> /dev/null; then
    pass "Qdrant running (:6333)"
else
    warn "Qdrant not running (start with: docker compose up -d qdrant)"
fi

# Check Neo4j
if curl -s http://localhost:7474 &> /dev/null; then
    pass "Neo4j running (:7474)"
else
    warn "Neo4j not running (start with: docker compose up -d neo4j)"
fi

# Check Zoekt
if curl -s http://localhost:6070/healthz &> /dev/null; then
    pass "Zoekt running (:6070)"
else
    warn "Zoekt not running (start with: docker compose up -d zoekt)"
fi

# Check MCP Gateway
if curl -s http://localhost:3100/health &> /dev/null; then
    pass "MCP Gateway running (:3100)"
else
    warn "MCP Gateway not running"
fi

echo ""

# -----------------------------------------------------------------------------
# Phase 4: Test Sample Repository
# -----------------------------------------------------------------------------
echo "Phase 4: Sample Repository"
echo "---------------------------------------------"

SAMPLE_REPO="$PROJECT_DIR/test/sample-repo"
if [[ -d "$SAMPLE_REPO/src" ]]; then
    FILE_COUNT=$(find "$SAMPLE_REPO/src" -name "*.cs" | wc -l)
    pass "Sample repo exists ($FILE_COUNT .cs files)"

    # List files for reference
    info "Files:"
    find "$SAMPLE_REPO/src" -name "*.cs" -exec basename {} \; | while read f; do
        info "  - $f"
    done
else
    warn "Sample repo not found"
fi

echo ""

# -----------------------------------------------------------------------------
# Phase 5: Test MCP Tools (if gateway running)
# -----------------------------------------------------------------------------
echo "Phase 5: MCP Tool Tests"
echo "---------------------------------------------"

if curl -s http://localhost:3100/health &> /dev/null; then

    # Test find_existing_behavior
    echo -n "  Testing find_existing_behavior... "
    RESULT=$(curl -s -X POST http://localhost:3100/api/tools/find_existing_behavior \
        -H "Content-Type: application/json" \
        -d '{
            "description": "validate email address format",
            "language": "csharp"
        }' 2>/dev/null || echo '{"error":"failed"}')

    if echo "$RESULT" | jq -e '.candidates' &> /dev/null; then
        CANDIDATES=$(echo "$RESULT" | jq '.candidates | length')
        pass "found $CANDIDATES candidates"
    else
        warn "no results (may need indexing)"
    fi

    # Test find_symbols
    echo -n "  Testing find_symbols... "
    RESULT=$(curl -s -X POST http://localhost:3100/api/tools/find_symbols \
        -H "Content-Type: application/json" \
        -d '{
            "query": "*Shipping*",
            "language": "csharp"
        }' 2>/dev/null || echo '{"error":"failed"}')

    if echo "$RESULT" | jq -e '.symbols' &> /dev/null; then
        SYMBOLS=$(echo "$RESULT" | jq '.symbols | length')
        pass "found $SYMBOLS symbols"
    else
        warn "no results (may need indexing)"
    fi

    # Test detect_duplicates
    echo -n "  Testing detect_duplicates... "
    RESULT=$(curl -s -X POST http://localhost:3100/api/tools/detect_duplicates \
        -H "Content-Type: application/json" \
        -d '{
            "description": "validate that an email address is properly formatted",
            "language": "csharp",
            "threshold": 0.6
        }' 2>/dev/null || echo '{"error":"failed"}')

    if echo "$RESULT" | jq -e '.duplicates' &> /dev/null; then
        DUPS=$(echo "$RESULT" | jq '.duplicates | length')
        if [[ "$DUPS" -gt 0 ]]; then
            pass "found $DUPS potential duplicates"
        else
            info "no duplicates found"
        fi
    else
        warn "check failed"
    fi

else
    warn "MCP Gateway not running - skipping tool tests"
    info "Start with: cd services/mcp-gateway && npm run dev"
fi

echo ""

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo "============================================="
echo "Test Complete"
echo "============================================="
echo ""
echo "Expected duplicates in sample repo:"
echo "  1. EmailValidator.IsValid ≈ StringExtensions.IsValidEmail (exact)"
echo "  2. StringExtensions.ToSlug ≈ OrderHelpers.GenerateSlug (exact)"
echo "  3. ShippingService.CalculateDomesticShipping ≈ OrderHelpers.ComputeShippingCost (near)"
echo ""
echo "To run full system:"
echo "  docker compose up -d"
echo "  cd services/mcp-gateway && npm install && npm run dev"
echo ""
