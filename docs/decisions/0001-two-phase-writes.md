# 0001. Two-phase writes: propose a plan, apply only an approved plan

Status: accepted, 2026-10-04

## Context

The harness changes orders in Distru on the strength of a buyer's email or spreadsheet, read by a model. A model can misread the source, be steered by text inside it, or call a write tool in the wrong order. Distru's order upsert is a single call that creates or replaces, with no draft state and no conditional write. Whatever the agent sends is what the order becomes.

## Decision

Every write is two calls on the Distru MCP server.

1. `propose_order_change` (scope `orders:propose`) reads the current order, builds the exact upsert body Distru would receive, and returns a plan: the request, the order's `updated_datetime` it was computed against, a semantic diff, a destructive flag and a hash over tenant, order, base timestamp and request. It writes nothing to Distru.
2. `apply_plan` (scope `orders:apply`) executes a plan by id. It checks that a human approval exists for that plan with the same hash and, for a destructive plan, that the approval acknowledged the deletions. It then claims the plan with a conditional APPROVED to APPLYING update, so concurrent or repeated calls write at most once. It re-reads the order and refuses if `updated_datetime` moved since the plan was computed, and otherwise sends the stored request verbatim. A call on an APPLIED plan returns the stored result.

Plans are immutable once proposed; only their status changes. The approval is recorded by a different principal kind (human, `orders:approve`) in a different process (the console), in one transaction with its audit row.

## Consequences

- No model ever holds `orders:apply`. The model's job ends at a proposal, so prompt injection or a bad extraction can at worst produce a plan that a verifier and a human then see.
- What the human approves is exactly what is sent: the hash binds the approval to the body.
- The stale check is a read then a write. Distru offers no conditional update, so a change landing between the re-read and the upsert is not caught. The window is milliseconds rather than the minutes or hours a plan waits for approval.
- If Distru accepts the write and the response is lost, the plan is marked FAILED. Re-proposing an edit is safe because the order is re-read; re-proposing a create could duplicate it. Not solved here.
- Every write costs a human decision. That is the point for edits to existing orders; for low-risk creates a policy could auto-approve, but none is implemented.

Code: `packages/mcp-distru/src/propose.ts`, `plans.ts`, `apply.ts`; `packages/db/src/plan-store.ts`.
