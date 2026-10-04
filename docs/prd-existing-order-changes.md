# PRD (draft): AI-proposed changes to existing sales orders

Draft for Ariel Agor's Senior AI Product Manager application, 2026-10-04. Drafted with Claude; the
product calls are Ariel's. Every claim about Distru comes from its public API docs
(apidocs.distru.dev). I have no access to Distru's product or data, so anything about today's UI or
workflow is marked as an assumption. Prototype: opsharness, against a mock of the published API with
synthetic data.

## User and problem

The user is the sales or operations rep who gets a buyer's change to an order already in Distru:
more of one product, drop another, swap a SKU. *Assumption:* these arrive the way new orders do, as
emails and texts.

Changing an order is riskier than creating one. Per the API docs, an order update that sends `items`
replaces the whole line set: an existing line whose `id` is left out is deleted. Updates never add
preset charges, and an auto-applied charge is not removed when the lines that added it are deleted.
So an agent that rebuilds the line list from a buyer's email can delete lines nobody mentioned and
leave a charge that no longer fits, while its own summary ("added 5 units of X") is true.

## What the AI does

| | v1 behavior |
|---|---|
| Suggests | Reads the message, matches each request to a line on the existing order, and proposes the change. The rep sees a before/after diff that code computes from the actual request, not the agent's description of it. |
| Asks | When a request matches more than one line, or no line, it asks instead of guessing. |
| Automates | Nothing writes on its own in v1. |
| Never | Deletes a line the buyer did not name. Every existing line is sent by `id`, so no deletion is implicit; a deletion is explicit, shown in red, and held for approval. Charges the change may affect are flagged, never edited silently. |

## Success and stop conditions

- **Primary metric:** share of proposals a rep approves without editing.
- **Speed:** time from the buyer's message to the updated order (baseline to be measured first).
- **Guardrail:** zero line deletions a person did not approve. One is a stop-ship bug.
- **Stop:** if reps rewrite most proposals for two weeks, matching is not good enough; pause and fix
  before widening.
- **Graduate:** only add-only changes with no deletions and no charge effects can move to
  apply-without-review, per customer, after a sustained unedited-approval rate set with CS.

## Rollout

1. Weeks 1 to 2: with CS, measure today's baseline (time from a buyer's message to the updated
   order) on two or three accounts that send frequent changes.
2. Weeks 3 to 6: v1 on those accounts, suggest and ask only. A weekly note to CS and sales:
   proposals made, share approved unedited, edits by type, any unapproved deletion.
3. Week 6 review with CS: widen to more accounts, or pause and fix matching.
4. Apply-without-review and invoices come after that review, not before.

## Out of scope

New orders, invoices (the docs give their `items` the same replacement rule; a later release),
compliance transfers (the API already rejects deleting package-tracked lines on a matched order),
price changes.

## Open questions

How reps handle changes today, and whether the order screen already guards deletions; I know only
the API.
