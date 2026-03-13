#!/usr/bin/env bash
# Seed test data into Qdrant for testing

set -euo pipefail

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
MODEL="${EMBEDDING_MODEL:-all-minilm}"

echo "Creating Qdrant collection..."
curl -s -X PUT "$QDRANT_URL/collections/code_chunks" \
  -H "Content-Type: application/json" \
  -d '{
    "vectors": {
      "size": 384,
      "distance": "Cosine"
    }
  }' | jq .

# Function to get embedding and insert point
insert_symbol() {
    local id=$1
    local name=$2
    local qualified_name=$3
    local symbol_type=$4
    local file_path=$5
    local description=$6
    local line_start=$7

    echo "Indexing $name..."

    # Get embedding
    local embedding
    embedding=$(curl -s "$OLLAMA_URL/api/embeddings" \
        -d "{\"model\":\"$MODEL\",\"prompt\":\"$description\"}" \
        | jq -c '.embedding')

    # Insert point
    curl -s -X PUT "$QDRANT_URL/collections/code_chunks/points" \
        -H "Content-Type: application/json" \
        -d "{
            \"points\": [{
                \"id\": $id,
                \"vector\": $embedding,
                \"payload\": {
                    \"symbol_id\": \"test:$id\",
                    \"name\": \"$name\",
                    \"qualified_name\": \"$qualified_name\",
                    \"symbol_type\": \"$symbol_type\",
                    \"file_path\": \"$file_path\",
                    \"line_start\": $line_start,
                    \"language\": \"csharp\",
                    \"namespace\": \"SampleApp\",
                    \"signature\": \"$name()\",
                    \"usage_count\": 5
                }
            }]
        }" > /dev/null
}

echo ""
echo "Inserting test symbols..."

# EmailValidator.IsValid
insert_symbol 1 "IsValid" "SampleApp.Validation.EmailValidator.IsValid" "method" \
    "src/EmailValidator.cs" \
    "Validates that an email address is properly formatted using regex pattern matching" \
    17

# StringExtensions.IsValidEmail (duplicate of above)
insert_symbol 2 "IsValidEmail" "SampleApp.Extensions.StringExtensions.IsValidEmail" "method" \
    "src/StringExtensions.cs" \
    "Extension method to validate email address format using regex" \
    11

# StringExtensions.ToSlug
insert_symbol 3 "ToSlug" "SampleApp.Extensions.StringExtensions.ToSlug" "method" \
    "src/StringExtensions.cs" \
    "Convert text to URL-friendly slug by lowercasing and replacing non-alphanumeric characters" \
    23

# OrderHelpers.GenerateSlug (duplicate of above)
insert_symbol 4 "GenerateSlug" "SampleApp.Helpers.OrderHelpers.GenerateSlug" "method" \
    "src/OrderHelpers.cs" \
    "Generate URL slug from title by lowercasing and replacing special characters with hyphens" \
    17

# ShippingService.CalculateDomesticShipping
insert_symbol 5 "CalculateDomesticShipping" "SampleApp.Services.ShippingService.CalculateDomesticShipping" "method" \
    "src/ShippingService.cs" \
    "Calculate shipping cost for domestic orders based on weight in kilograms and shipping zone" \
    20

# OrderHelpers.ComputeShippingCost (near duplicate of above)
insert_symbol 6 "ComputeShippingCost" "SampleApp.Helpers.OrderHelpers.ComputeShippingCost" "method" \
    "src/OrderHelpers.cs" \
    "Compute shipping cost based on package weight and shipping zone number" \
    10

# ShippingService.CalculateInternationalShipping
insert_symbol 7 "CalculateInternationalShipping" "SampleApp.Services.ShippingService.CalculateInternationalShipping" "method" \
    "src/ShippingService.cs" \
    "Calculate shipping cost for international orders based on weight and country code" \
    35

# ShippingService.GetEstimatedDelivery
insert_symbol 8 "GetEstimatedDelivery" "SampleApp.Services.ShippingService.GetEstimatedDelivery" "method" \
    "src/ShippingService.cs" \
    "Get estimated delivery date based on shipping zone and expedited flag" \
    47

# OrderHelpers.CalculateTax
insert_symbol 9 "CalculateTax" "SampleApp.Helpers.OrderHelpers.CalculateTax" "method" \
    "src/OrderHelpers.cs" \
    "Calculate sales tax amount based on subtotal and US state code" \
    30

# IShippingService interface
insert_symbol 10 "IShippingService" "SampleApp.Services.IShippingService" "interface" \
    "src/ShippingService.cs" \
    "Interface for shipping calculation services with domestic and international methods" \
    58

echo ""
echo "Verifying..."
COUNT=$(curl -s "$QDRANT_URL/collections/code_chunks" | jq '.result.points_count')
echo "Points in collection: $COUNT"

echo ""
echo "Test search for 'validate email'..."
QUERY_EMBED=$(curl -s "$OLLAMA_URL/api/embeddings" \
    -d '{"model":"all-minilm","prompt":"validate email address"}' \
    | jq -c '.embedding')

curl -s -X POST "$QDRANT_URL/collections/code_chunks/points/search" \
    -H "Content-Type: application/json" \
    -d "{
        \"vector\": $QUERY_EMBED,
        \"limit\": 3,
        \"with_payload\": true
    }" | jq '.result[] | {name: .payload.name, score: .score, file: .payload.file_path}'

echo ""
echo "Done! Test data seeded."
