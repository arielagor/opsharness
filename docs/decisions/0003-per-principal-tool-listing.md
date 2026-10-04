# 0003. Per-principal tool listing

Status: accepted, 2026-10-04

## Context

An MCP server usually lists every tool it has and checks permissions when a tool is called. For a model that is the wrong shape: a listed tool is an invitation. A model that sees `apply_plan` in its tool list will, sooner or later, call it, and text inside an email can ask it to. A call-time check stops the write but leaves the model planning around a tool it should not know about.

The harness also serves several tenants. A tool that takes a tenant or account argument lets a confused or steered model ask for another tenant's data.

## Decision

- **The server is built for one principal.** `buildDistruMcpServer` and the workspace server take a principal (id, tenant, kind, scopes) and register only the tools whose scope the principal holds. An unregistered tool is neither listed nor callable. Each handler checks its scope again.
- **The tenant comes from the principal, never from an argument.** The Distru client is bound to the principal's tenant credentials. No tool takes a tenant id. Another tenant's order id is just "not found".
- **Some scopes can never reach a model.** `orders:apply` and `orders:approve` are human or service scopes. `definePrincipal` throws if an agent principal is given either, so a misconfigured grant fails at startup instead of quietly exposing a write tool.
- **Over HTTP, the principal is fixed per session.** The Streamable HTTP transport maps a bearer token to a principal when the session is initialised; every later request on that session must authenticate as the same principal, so a session id alone grants nothing.
- **A principal with no tools gets an empty list.** MCP SDK 1.32 installs its `tools/list` handler only on the first registration, so a principal with zero grants got a "method not found" error. Both servers register and remove a placeholder to install it; a regression test covers it.

The demo principals per tenant: the intake agent (mail, sheets, product search), the ERP agent (reads plus `orders:propose`), a read-only agent, a human approver (reads plus `orders:approve`), a verifier service (reads) and an applier service (`orders:read`, `orders:apply`).

## Consequences

- Each graph node talks to an MCP server built for its own principal, so the audit trail records which principal made each call.
- The intake agent cannot see orders and the ERP agent cannot read mail, which limits what an injection in an email can reach to the intake agent's read tools.
- Building a server per principal costs a little per run. Not measured as a problem at this scale.

Code: `packages/core/src/principal.ts`, `packages/core/src/demo.ts`, `packages/mcp-distru/src/server.ts`, `packages/mcp-distru/src/http.ts`, `packages/mcp-workspace/src/server.ts`. Tests: "each principal sees only the tools its scopes grant", "no agent principal is ever offered apply_plan", "lists tools per authenticated principal", "rejects missing credentials, and a session id presented by another principal".
