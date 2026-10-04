# 0002. The nested-items deletion guard

Status: accepted, 2026-10-04 (revised the same day, see "Revision")

## Context

Distru's order upsert treats `items` as the complete set of lines when it is sent. An existing line whose `id` is not in the array is deleted. So "change the quantity on one line" sent the obvious way, with only that line, deletes every other line on the order. Nothing in the response says so beyond the missing rows. This is the sharpest edge an agent editing existing orders can hit, and it is the case a cart-building agent never meets.

## Decision

Three layers, each in code.

1. **The diff names every deletion.** `propose_order_change` compares the request with the current order and lists lines as added, changed, kept or deleted. Each deleted line is named with SKU, quantity, price and line id, and makes the plan destructive (`destructive_reasons`). A line id that does not exist on the order is refused at proposal time, so a hallucinated id cannot hide a deletion.
2. **The verifier blocks deletions the source did not ask for.** Intake marks an explicit removal ("remove X") as a draft line with quantity 0, and nothing else uses quantity 0. The verifier's `no_unrequested_deletion` check blocks the run for every deleted line the source did not ask to remove, before a human sees it, and `plan_matches_source` blocks a plan that skips a requested removal.
3. **A requested deletion needs an explicit acknowledgement.** Approving a destructive plan without `acknowledgeDestructive` is refused in the plan store, and `apply_plan` refuses an approval that lacks it. The console shows deleted lines in red with the acknowledgement as a separate checkbox.

## Revision

The first version had layers 1 and 3 only. In hand testing, a deliberately naive model sent only the changed line for an email that said to keep everything else. The plan was flagged destructive and held, I ticked the acknowledgement as the approver, and the mock deleted the line. Eval S06 had recorded that outcome as a pass. The acknowledgement guards against a human approving a deletion without noticing it. It does not guard against an agent deleting something nobody asked for, because a reviewer under time pressure ticks the box. Layer 2 was added, S06 now expects BLOCKED, and S14 and S15 cover a requested removal and a careful edit. With the check forced to pass, S06 fails (VERIFY.md section 5a).

## Consequences

- A correct edit has to send every kept line by id. The ERP prompt says so, and the scripted "careful" model does it; the verifier, not the prompt, is what enforces it.
- A buyer who asks to "replace the order with" a new list needs explicit removals for the lines being dropped, or the plan is blocked and asks. That is the safe failure.
- Cancelling an order is also a destructive reason. The verifier does not compare header changes such as status with the source, so a cancellation the source did not ask for is caught only by the acknowledgement. That is a known gap, the same one this ADR closed for lines.

Code: `packages/mcp-distru/src/propose.ts`, `apps/harness/src/verifier.ts`, `apps/harness/src/prompts.ts`, `packages/db/src/plan-store.ts`, `apps/web/src/components/plan-diff.tsx`.
