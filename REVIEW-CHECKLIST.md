# Review checklist

For a human or an agent reviewing a change. Work through the sections that apply and say which ones did not.

## Writes to Distru

- [ ] The only call that writes is `apply_plan`, from the graph's `apply` node, as a service principal.
- [ ] `apply_plan` still sends the stored request verbatim. Nothing between approval and apply can change the body.
- [ ] Apply still refuses a plan whose order changed after it was computed, and a replay returns the stored result.
- [ ] Any new update path sends existing lines by `id`. An existing line left out of `items` is deleted by Distru.
- [ ] A new destructive effect (beyond deleted lines and cancelling) adds a `destructive_reasons` entry, and the verifier decides whether the source asked for it.

## The approval

- [ ] A decision is recorded only for a plan whose run is AWAITING_APPROVAL, with a matching hash, by a principal holding `orders:approve`.
- [ ] Destructive plans still require `acknowledgeDestructive`, in the store and in every caller.
- [ ] The decision, the plan status and the audit row commit in one transaction.
- [ ] No UPDATE or DELETE on the audit tables (the database refuses them; do not drop that trigger).

## Agents and tools

- [ ] New tools declare a scope, and a principal without it does not see the tool.
- [ ] No tool takes a tenant argument.
- [ ] No agent principal holds `orders:apply` or `orders:approve`.
- [ ] Content from email or sheets reaches a model only inside the `<untrusted_content>` frame.
- [ ] A new business rule is a verifier check with an eval that fails when the check is forced to pass, not prompt text.

## Evals and tests

- [ ] `pnpm evals` passes, and no scenario's expectation was loosened to get there. If one changed, the commit says why.
- [ ] A bug fix comes with a test or scenario that fails without it.
- [ ] Database-backed tests clean up after themselves or use unique ids.

## Data and claims

- [ ] Fixtures and seed data are SYNTHETIC and labelled. No real company, customer or person.
- [ ] No number in README.md or BUILD-LOG.md that VERIFY.md does not reproduce.
- [ ] Nothing claims production use or access to a real Distru account.
- [ ] No secrets, `.env` files or local absolute paths in the diff. `.env.example` holds placeholders only.

## Console

- [ ] Loading, empty and error states for any new view.
- [ ] Another tenant's id resolves to 404 or null, never to an error that confirms it exists.
- [ ] The viewer comes from server configuration, never from the request.
