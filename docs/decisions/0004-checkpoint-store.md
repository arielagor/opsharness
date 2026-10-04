# 0004. Checkpoints in Postgres, beside the control-plane tables

Status: accepted, 2026-10-04

## Context

A run stops at the approval gate and waits for a human, which can take minutes or days. The process that started it will not be the process that finishes it: the CLI exits, a worker restarts, a deploy happens. The run's state (the extracted draft, the plan id, the verifier's verdict, where the graph is) has to survive that, and the resume has to be safe if two workers pick it up.

## Decision

- **LangGraph's `PostgresSaver`**, in its own `langgraph` schema of the same Postgres database that holds the Prisma tables (tenants, principals, grants, runs, tool calls, plans, approvals). The thread id is the run id.
- **The approval gate is `interrupt()`.** When the gate is reached the graph stops and the run is marked AWAITING_APPROVAL. Nothing is held in memory.
- **The recorded decision is the source of truth, not the resume payload.** A worker resumes any AWAITING_APPROVAL run whose plan has a recorded decision. On resume the gate re-reads the decision from the `approvals` table, so a resume value cannot approve anything. Routing to `apply` requires an APPROVED decision; a harness test checks the router never does otherwise.
- **Resume is safe to repeat.** `apply_plan` is idempotent per plan (ADR 0001), so two workers resuming one run write once.

## Alternatives considered

- **In-memory saver:** loses every waiting run on restart. Fine for tests, not for an approval that waits a day.
- **A separate store (Redis, SQLite):** a second system to run and back up, and no transaction shared with the approval tables. One Postgres keeps the operational picture simple.
- **No graph state at all, rebuild from tables:** possible, since plans and decisions are already in tables, but it means re-implementing what the checkpointer gives for free and loses the ability to inspect a run's exact state at the gate.

## Consequences

- Eval S10 starts a run, discards the harness, builds a new one against the same database, records a decision, and resumes to APPLIED with one write.
- The checkpoint tables are LangGraph's schema, not ours. Migrations for them come from `checkpointer.setup()`, not Prisma.
- A run inserted without a checkpoint (as the web tests do) cannot be resumed; the worker marks it FAILED. That only happens with test data in the demo database.

Code: `apps/harness/src/harness.ts`, `apps/harness/src/graph.ts`.
