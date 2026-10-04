import { createGraphQLError, createSchema, createYoga } from 'graphql-yoga'
import { hasScope, type Principal } from '@opsharness/core'
import { loadPrincipal, type Db, type PrismaPlanStore, type RunStatus, type RunStore } from '@opsharness/db'

/**
 * The console's only data path. Every resolver is scoped to the viewer's tenant and checks the
 * viewer's scopes; a run or plan id from another tenant resolves to null, never to an error that
 * confirms it exists.
 */
export interface GqlContext {
  db: Db
  runs: RunStore
  plans: PrismaPlanStore
  viewer: Principal
}

const typeDefs = /* GraphQL */ `
  enum RunStatus { RUNNING AWAITING_APPROVAL APPLIED REJECTED BLOCKED NEEDS_CLARIFICATION FAILED }
  enum Decision { APPROVED REJECTED }

  type Viewer { id: ID!, tenantId: String!, tenantName: String!, displayName: String!, canApprove: Boolean! }

  type Usage { modelTurns: Int!, inputTokens: Int!, outputTokens: Int!, modelLatencyMs: Float!, toolCalls: Int!, toolLatencyMs: Float! }

  type ToolCall {
    id: ID!
    server: String!
    tool: String!
    node: String
    principalId: String!
    ok: Boolean!
    error: String
    latencyMs: Float!
    inputTokens: Int
    outputTokens: Int
    traceId: String
    startedAt: String!
    "JSON, truncated for audit"
    args: String!
    "JSON, truncated for audit"
    result: String
  }

  type Line { lineId: String, sku: String!, name: String!, quantity: Float!, price: Float! }
  type FieldChange { field: String!, from: String, to: String }
  type ChangedLine { lineId: String, sku: String!, name: String!, quantity: Float!, price: Float!, changes: [FieldChange!]! }
  type PlanLines { added: [Line!]!, changed: [ChangedLine!]!, kept: [Line!]!, deleted: [Line!]! }

  type ApprovalRecord { decision: Decision!, approverId: String!, acknowledgeDestructive: Boolean!, decidedAt: String!, note: String }

  type Plan {
    id: ID!
    runId: String
    status: String!
    kind: String!
    orderNumber: String
    customer: String
    destructive: Boolean!
    destructiveReasons: [String!]!
    header: [FieldChange!]!
    lines: PlanLines!
    summary: String!
    rationale: String!
    hash: String!
    createdAt: String!
    approval: ApprovalRecord
  }

  type Run {
    id: ID!
    sourceKind: String!
    sourceRef: String!
    status: RunStatus!
    mode: String!
    model: String
    summary: String
    createdAt: String!
    updatedAt: String!
    trail: [String!]!
    warnings: [String!]!
    blockers: [String!]!
    injectionSuspected: Boolean!
    usage: Usage!
    toolCalls: [ToolCall!]!
    plans: [Plan!]!
  }

  type Query {
    viewer: Viewer!
    runs(status: [RunStatus!], limit: Int): [Run!]!
    run(id: ID!): Run
    "Plans waiting for a human: proposed, verified, held at the approval gate."
    approvals: [Plan!]!
  }

  type DecisionResult { ok: Boolean!, error: String, planId: ID!, decision: Decision }

  type Mutation {
    "Records a human decision. The worker resumes the run; this never writes to Distru."
    decide(planId: ID!, planHash: String!, decision: Decision!, acknowledgeDestructive: Boolean!, note: String): DecisionResult!
  }
`

type RunRow = Awaited<ReturnType<RunStore['listRuns']>>[number]
type PlanRowT = NonNullable<Awaited<ReturnType<RunStore['getRun']>>>['plans'][number]

interface LineView { line_id: string | null; sku: string; product_name: string; quantity: number; price: number }
interface PlanDiffJson {
  kind: string
  order_number: string | null
  customer: { name: string } | null
  header: { field: string; from: unknown; to: unknown }[]
  lines: { added: LineView[]; changed: (LineView & { changes: { field: string; from: unknown; to: unknown }[] })[]; kept: LineView[]; deleted: LineView[] }
  destructive_reasons: string[]
  summary: string
}

const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v))
const line = (l: LineView) => ({ lineId: l.line_id, sku: l.sku, name: l.product_name, quantity: l.quantity, price: l.price })
const change = (c: { field: string; from: unknown; to: unknown }) => ({ field: c.field, from: str(c.from), to: str(c.to) })

function need(ctx: GqlContext, scope: Parameters<typeof hasScope>[1]) {
  if (!hasScope(ctx.viewer, scope)) throw createGraphQLError(`Viewer lacks ${scope}`, { extensions: { code: 'FORBIDDEN' } })
}

function planView(p: PlanRowT) {
  const d = p.diff as unknown as PlanDiffJson
  return {
    id: p.id,
    runId: p.runId,
    status: p.status,
    kind: d.kind,
    orderNumber: d.order_number,
    customer: d.customer?.name ?? null,
    destructive: p.destructive,
    destructiveReasons: d.destructive_reasons,
    header: d.header.map(change),
    lines: { added: d.lines.added.map(line), changed: d.lines.changed.map((l) => ({ ...line(l), changes: l.changes.map(change) })), kept: d.lines.kept.map(line), deleted: d.lines.deleted.map(line) },
    summary: d.summary,
    rationale: p.rationale,
    hash: p.hash,
    createdAt: p.createdAt.toISOString(),
    approval: p.approval ? { decision: p.approval.decision, approverId: p.approval.approverId, acknowledgeDestructive: p.approval.acknowledgeDestructive, decidedAt: p.approval.decidedAt.toISOString(), note: p.approval.note } : null,
  }
}

function runView(r: RunRow) {
  const o = (r.outcome ?? {}) as { trail?: string[]; verdict?: { warnings?: string[]; blockers?: string[] } | null; injection_suspected?: boolean }
  return {
    id: r.id,
    tenantId: r.tenantId,
    sourceKind: r.sourceKind,
    sourceRef: r.sourceRef,
    status: r.status,
    mode: r.mode,
    model: r.model,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    trail: o.trail ?? [],
    warnings: o.verdict?.warnings ?? [],
    blockers: o.verdict?.blockers ?? [],
    injectionSuspected: o.injection_suspected ?? false,
  }
}

type RunViewT = ReturnType<typeof runView>

export const schema = createSchema<GqlContext>({
  typeDefs,
  resolvers: {
    Query: {
      viewer: async (_: unknown, __: unknown, ctx: GqlContext) => {
        const t = await ctx.db.tenant.findUnique({ where: { id: ctx.viewer.tenantId } })
        return { id: ctx.viewer.id, tenantId: ctx.viewer.tenantId, tenantName: t?.name ?? ctx.viewer.tenantId, displayName: ctx.viewer.displayName, canApprove: hasScope(ctx.viewer, 'orders:approve') }
      },
      runs: async (_: unknown, a: { status?: RunStatus[]; limit?: number }, ctx: GqlContext) => {
        need(ctx, 'orders:read')
        const rows = await ctx.runs.listRuns(ctx.viewer.tenantId, { ...(a.status ? { status: a.status } : {}), take: Math.min(a.limit ?? 50, 200) })
        return rows.map(runView)
      },
      run: async (_: unknown, a: { id: string }, ctx: GqlContext) => {
        need(ctx, 'orders:read')
        const r = await ctx.db.run.findFirst({ where: { id: a.id, tenantId: ctx.viewer.tenantId } })
        return r ? runView(r) : null
      },
      approvals: async (_: unknown, __: unknown, ctx: GqlContext) => {
        need(ctx, 'orders:read')
        const rows = await ctx.db.plan.findMany({
          where: { tenantId: ctx.viewer.tenantId, status: 'PROPOSED', approval: null, run: { status: 'AWAITING_APPROVAL' } },
          include: { approval: true },
          orderBy: { createdAt: 'asc' },
        })
        return rows.map(planView)
      },
    },
    Run: {
      usage: (r: RunViewT, _: unknown, ctx: GqlContext) => ctx.runs.runUsage(ctx.viewer.tenantId, r.id),
      toolCalls: async (r: RunViewT, _: unknown, ctx: GqlContext) => {
        const rows = await ctx.db.toolCall.findMany({ where: { runId: r.id, tenantId: ctx.viewer.tenantId }, orderBy: { startedAt: 'asc' } })
        return rows.map((c) => ({ ...c, startedAt: c.startedAt.toISOString(), args: JSON.stringify(c.args), result: c.result === null ? null : JSON.stringify(c.result) }))
      },
      plans: async (r: RunViewT, _: unknown, ctx: GqlContext) => {
        const rows = await ctx.db.plan.findMany({ where: { runId: r.id, tenantId: ctx.viewer.tenantId }, include: { approval: true }, orderBy: { createdAt: 'asc' } })
        return rows.map(planView)
      },
    },
    Mutation: {
      decide: async (_: unknown, a: { planId: string; planHash: string; decision: 'APPROVED' | 'REJECTED'; acknowledgeDestructive: boolean; note?: string | null }, ctx: GqlContext) => {
        need(ctx, 'orders:approve')
        // Only a plan the graph is holding at the approval gate can be decided. A blocked run's plan
        // stays PROPOSED but is not in the inbox; posting its id directly must not approve it.
        const held = await ctx.db.plan.findFirst({ where: { id: a.planId, tenantId: ctx.viewer.tenantId }, select: { run: { select: { status: true } } } })
        if (held?.run && held.run.status !== 'AWAITING_APPROVAL') return { ok: false, error: `This plan is not waiting for approval (its run is ${held.run.status}).`, planId: a.planId, decision: null }
        try {
          const r = await ctx.plans.recordDecision(ctx.viewer.tenantId, {
            planId: a.planId,
            planHash: a.planHash,
            decision: a.decision,
            approverId: ctx.viewer.id,
            acknowledgeDestructive: a.acknowledgeDestructive,
            ...(a.note ? { note: a.note } : {}),
          })
          return { ok: true, error: null, planId: a.planId, decision: r.decision }
        } catch (e) {
          // DecisionError messages are written for the approver (stale hash, unacknowledged deletions, already decided).
          return { ok: false, error: (e as Error).message, planId: a.planId, decision: null }
        }
      },
    },
  },
})

export async function contextFor(db: Db, runs: RunStore, plans: PrismaPlanStore, viewerId: string): Promise<GqlContext> {
  const tenantId = viewerId.split('@')[1] ?? ''
  const viewer = await loadPrincipal(db, tenantId, viewerId)
  if (!viewer) throw new Error(`Console principal ${viewerId} is not seeded`)
  return { db, runs, plans, viewer }
}

/**
 * One yoga instance per configured viewer. The viewer comes from server configuration, never
 * from the request, so an HTTP caller cannot pick whose tenant it reads.
 */
export function makeYoga(context: () => Promise<GqlContext>) {
  return createYoga<object, GqlContext>({
    schema,
    context,
    graphqlEndpoint: '/api/graphql',
    fetchAPI: { Response, Request },
    graphiql: false,
    // Unexpected errors reach the client as "Unexpected error."; FORBIDDEN and decision messages are deliberate.
    maskedErrors: true,
    logging: false,
  })
}

export type Yoga = ReturnType<typeof makeYoga>

/** Executes a document through yoga in process: same parsing, validation and masking as HTTP. */
export async function execute<T>(yoga: Yoga, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await yoga.fetch('http://in-process/api/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data as T
}
