# Agent Prompt Contract: Search Before Write

This document defines the behavioral contract that AI agents must follow when creating code in repositories indexed by Codebase Brain.

## Core Principle

**No new code without search evidence.**

Before writing any new method, class, or significant code block, agents MUST:

1. Search for existing behavior
2. Review candidates
3. Justify why existing code is insufficient
4. Get approval from the pre-write guard

## Required Workflow

### Phase 1: Discovery

Before proposing any new code, execute these searches:

```
1. find_existing_behavior
   - Input: Natural language description of what you need
   - Review: Top 5 candidates minimum

2. find_symbols
   - Input: Likely names/patterns for this functionality
   - Review: Check if interface exists, check implementations

3. trace_usage (if candidates found)
   - Input: Promising candidates from steps 1-2
   - Review: How central is this code? Who uses it?
```

### Phase 2: Evaluation

For each candidate with similarity > 0.6:

| Question | Action if Yes |
|----------|---------------|
| Does it do exactly what I need? | Use it directly |
| Does it do 80% of what I need? | Extend it |
| Does it have the right interface but wrong implementation? | Wrap/adapt it |
| Is it in the right architectural layer? | Prefer it over creating new |

### Phase 3: Decision

Based on evaluation, choose ONE:

| Decision | When to Use | Required Evidence |
|----------|-------------|-------------------|
| **REUSE** | Existing code meets requirements | Candidate ID, why it fits |
| **EXTEND** | Existing code needs enhancement | Candidate ID, what's missing |
| **WRAP** | Existing code needs adaptation | Candidate ID, interface mismatch |
| **NEW** | No suitable candidates exist | List of reviewed candidates, why each was insufficient |

### Phase 4: Pre-Write Guard

Before writing new code, call `pre_write_guard` with:

```json
{
  "proposed_change": {
    "type": "new_method",
    "name": "CalculateShippingCost",
    "description": "Calculate shipping cost based on weight and destination",
    "file_path": "src/Services/ShippingService.cs"
  },
  "search_evidence": {
    "behavior_search_performed": true,
    "symbol_search_performed": true,
    "duplicate_check_performed": true,
    "candidates_reviewed": ["sym_123", "sym_456", "sym_789"],
    "rejection_reasons": {
      "sym_123": "Only handles domestic shipping, we need international",
      "sym_456": "Deprecated, marked for removal in v3",
      "sym_789": "Test utility, not production code"
    }
  },
  "justification": "No existing method handles international shipping cost calculation with the new carrier API"
}
```

## Prompt Integration

Add this to your agent's system prompt:

```markdown
## Code Creation Policy

You have access to Codebase Brain tools for code intelligence. Before creating ANY new:
- Method or function
- Class or interface
- Significant code block (>10 lines)

You MUST follow the Search Before Write protocol:

1. **ALWAYS** call `find_existing_behavior` first with a description of what you need
2. **ALWAYS** call `find_symbols` to check for similar names/patterns
3. **REVIEW** at least the top 3 candidates from each search
4. **TRACE** usage of promising candidates with `trace_usage`
5. **CHECK** for duplicates with `detect_duplicates` before writing
6. **CALL** `pre_write_guard` before creating new code

If pre_write_guard returns `blocked`, you MUST:
- NOT proceed with code creation
- Report the block reason to the user
- Suggest alternatives based on the guard's suggestions

If pre_write_guard returns `needs_human_review`, you MUST:
- Present the concerns to the user
- Wait for explicit approval before proceeding

You are NOT allowed to skip these steps or claim "I already know there's no existing code."
The system tracks your search history and will reject claims without evidence.
```

## Examples

### Good: Proper Search Flow

```
User: Add a method to validate email addresses

Agent: I'll search for existing email validation code first.

[calls find_existing_behavior("validate email address format", language="csharp")]

Found 3 candidates:
1. EmailValidator.IsValid (similarity: 0.92) - 47 usages
2. StringExtensions.IsValidEmail (similarity: 0.85) - 12 usages
3. ValidationHelpers.CheckEmail (similarity: 0.78) - 3 usages

[calls trace_usage("EmailValidator.IsValid")]

EmailValidator.IsValid has high centrality (47 callers across 12 services).
It handles standard RFC 5322 validation.

Recommendation: REUSE EmailValidator.IsValid

This existing method is well-tested, widely used, and meets your requirements.
Here's how to use it:

```csharp
using MaidCentral.Validation;

if (!EmailValidator.IsValid(email))
{
    return Result.Failure("Invalid email format");
}
```
```

### Bad: Skipping Search

```
User: Add a method to validate email addresses

Agent: I'll create a new email validation method:

```csharp
public static bool ValidateEmail(string email)
{
    var regex = new Regex(@"^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$");
    return regex.IsMatch(email);
}
```

[pre_write_guard BLOCKS: No behavior search performed.
 3 existing email validators found in codebase.
 Recommend: EmailValidator.IsValid (47 usages)]
```

### Good: Justified New Code

```
User: Add a method to validate email addresses that also checks MX records

Agent: I'll search for existing email validation with MX checking.

[calls find_existing_behavior("validate email with MX record DNS check")]

Found 2 candidates:
1. EmailValidator.IsValid (similarity: 0.72) - No MX checking
2. DnsHelpers.CheckMxRecord (similarity: 0.65) - MX only, no format validation

Neither combines format validation with MX checking.

[calls detect_duplicates with proposed implementation]

No duplicates found.

[calls pre_write_guard with evidence]

Guard: APPROVED - New functionality justified.
Suggestion: Consider extending EmailValidator rather than creating new class.

I'll add the MX-checking method to the existing EmailValidator:

```csharp
public static async Task<bool> IsValidWithMxCheck(string email)
{
    if (!IsValid(email))
        return false;

    var domain = email.Split('@')[1];
    return await DnsHelpers.CheckMxRecord(domain);
}
```
```

## Audit Trail

Every code creation decision is logged:

```json
{
  "timestamp": "2024-03-15T14:30:00Z",
  "agent_session": "abc123",
  "proposed_change": "new_method:CalculateShippingCost",
  "searches_performed": [
    {"type": "behavior", "results": 8, "reviewed": 5},
    {"type": "symbol", "results": 12, "reviewed": 4}
  ],
  "candidates_rejected": {
    "ShippingCalculator.Calculate": "Domestic only",
    "OrderService.GetShippingCost": "Deprecated"
  },
  "decision": "NEW",
  "guard_result": "APPROVED",
  "justification": "International shipping with new carrier API not supported"
}
```

## Metrics

Track these to measure policy effectiveness:

| Metric | Target | Description |
|--------|--------|-------------|
| Search compliance | 100% | % of new code preceded by searches |
| Reuse rate | >40% | % of requests resolved by reuse/extend |
| Block rate | <10% | % blocked by pre_write_guard |
| Duplicate introduction | 0% | New duplicates created post-policy |
| Code growth rate | -30% | Reduction in new lines added |

## Enforcement

The pre-write guard enforces this contract. Agents that repeatedly:
- Skip required searches
- Ignore reuse recommendations
- Create blocked code anyway

Will have their sessions flagged for review.
