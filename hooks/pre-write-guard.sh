#!/usr/bin/env bash
# =============================================================================
# CODEBASE BRAIN - PRE-WRITE GUARD HOOK FOR CLAUDE CODE
# =============================================================================
# This hook runs before Write/Edit tool calls and validates that proper
# search was performed before code creation.
#
# Install: Add to ~/.claude/hooks.json or project .claude/settings.json
#
# {
#   "hooks": {
#     "PreToolUse": [
#       {
#         "matcher": "Write|Edit",
#         "hooks": [
#           {
#             "type": "command",
#             "command": "/home/rscla/projects/codebase-brain/hooks/pre-write-guard.sh"
#           }
#         ]
#       }
#     ]
#   }
# }

set -euo pipefail

# Configuration
CODEBASE_BRAIN_URL="${CODEBASE_BRAIN_URL:-http://localhost:3100}"
SESSION_FILE="${CLAUDE_SESSION_DIR:-/tmp}/.codebase-brain-session"
MIN_SEARCH_COUNT=2
BLOCK_ON_FAILURE="${BLOCK_ON_FAILURE:-false}"

# Read tool input from stdin (Claude Code passes JSON)
INPUT=$(cat)

# Extract tool name and file path
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

# Skip non-code files
is_code_file() {
    local ext="${1##*.}"
    case "$ext" in
        cs|ts|tsx|js|jsx|py|java|go|rs|cpp|c|h|hpp)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Skip if not a code file
if [[ -z "$FILE_PATH" ]] || ! is_code_file "$FILE_PATH"; then
    exit 0
fi

# Check if this is new code creation (Write) vs modification (Edit)
IS_NEW_FILE=false
if [[ "$TOOL_NAME" == "Write" ]]; then
    # Check if file exists
    if [[ ! -f "$FILE_PATH" ]]; then
        IS_NEW_FILE=true
    fi
fi

# For edits, check if it's adding significant new code
if [[ "$TOOL_NAME" == "Edit" ]]; then
    NEW_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
    OLD_CONTENT=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty')

    # Count new lines vs old lines
    NEW_LINES=$(echo "$NEW_CONTENT" | wc -l)
    OLD_LINES=$(echo "$OLD_CONTENT" | wc -l)
    LINES_ADDED=$((NEW_LINES - OLD_LINES))

    # Skip if not adding significant code (< 10 net new lines)
    if [[ $LINES_ADDED -lt 10 ]]; then
        exit 0
    fi
fi

# Check session for recent searches
check_search_history() {
    if [[ ! -f "$SESSION_FILE" ]]; then
        return 1
    fi

    # Count recent codebase-brain tool calls (within last 5 minutes)
    local recent_searches
    recent_searches=$(find "$SESSION_FILE" -mmin -5 -exec cat {} \; 2>/dev/null | \
        grep -c "find_existing_behavior\|find_symbols\|detect_duplicates" || echo "0")

    if [[ $recent_searches -ge $MIN_SEARCH_COUNT ]]; then
        return 0
    fi
    return 1
}

# Query the pre-write guard API
query_guard() {
    local content
    content=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

    local response
    response=$(curl -s -X POST "${CODEBASE_BRAIN_URL}/api/pre-write-guard" \
        -H "Content-Type: application/json" \
        -d "{
            \"file_path\": \"$FILE_PATH\",
            \"content\": $(echo "$content" | jq -Rs .),
            \"is_new_file\": $IS_NEW_FILE,
            \"session_id\": \"${CLAUDE_SESSION_ID:-unknown}\"
        }" 2>/dev/null || echo '{"error": "Service unavailable"}')

    echo "$response"
}

# Main logic
main() {
    # If codebase-brain service is not running, warn but don't block
    if ! curl -s "${CODEBASE_BRAIN_URL}/health" >/dev/null 2>&1; then
        echo "warning: Codebase Brain service not available at ${CODEBASE_BRAIN_URL}" >&2
        exit 0
    fi

    # Check search history
    if ! check_search_history; then
        if [[ "$IS_NEW_FILE" == "true" ]] || [[ "${LINES_ADDED:-0}" -gt 20 ]]; then
            # Query the guard for significant new code
            GUARD_RESPONSE=$(query_guard)
            VERDICT=$(echo "$GUARD_RESPONSE" | jq -r '.verdict // "unknown"')

            case "$VERDICT" in
                "proceed")
                    # Approved
                    exit 0
                    ;;
                "blocked")
                    REASON=$(echo "$GUARD_RESPONSE" | jq -r '.concerns[0] // "Search required before creating code"')
                    SUGGESTIONS=$(echo "$GUARD_RESPONSE" | jq -r '.suggestions // []')

                    if [[ "$BLOCK_ON_FAILURE" == "true" ]]; then
                        echo "error: Pre-write guard blocked: $REASON" >&2
                        echo "suggestions: $SUGGESTIONS" >&2
                        exit 1
                    else
                        echo "warning: Pre-write guard concern: $REASON" >&2
                        echo "hint: Use find_existing_behavior or find_symbols before creating new code" >&2
                        exit 0
                    fi
                    ;;
                "needs_human_review")
                    CONCERNS=$(echo "$GUARD_RESPONSE" | jq -r '.concerns | join("; ")')
                    echo "warning: Human review recommended: $CONCERNS" >&2
                    exit 0
                    ;;
                *)
                    # Unknown response, don't block
                    exit 0
                    ;;
            esac
        fi
    fi

    exit 0
}

main "$@"
