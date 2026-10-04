import { definePrincipal, truncateForAudit, type Principal, type Scope } from '@opsharness/core'
import type { Db } from './client.js'
import type { Prisma, RunStatus } from './generated/prisma/client.js'

const json = (v: unknown) => (v === undefined ? undefined : (truncateForAudit(v) as Prisma.InputJsonValue))

/** One audit row: an MCP tool call, a model turn, or a harness step. */
export interface AuditRow {
  runId: string | null
  tenantId: string
  principalId: string
  server: 'distru' | 'workspace' | 'model' | 'harness' | 'human'
  tool: string
  node?: string
  args: unknown
  ok: boolean
  error?: string
  result?: unknown
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  modelTurnId?: string
  traceId?: string
  startedAt: string
}

export interface NewRun {
  id: string
  tenantId: string
  sourceKind: 'email' | 'sheet'
  sourceRef: string
  mode: 'scripted' | 'live'
  model: string | null
}

/** Runs and the audit trail. Every read takes the tenant. */
export class RunStore {
  constructor(private readonly db: Db) {}

  async createRun(r: NewRun) {
    return this.db.run.create({ data: { ...r, status: 'RUNNING', threadId: r.id } })
  }

  async updateRun(tenantId: string, id: string, patch: { status?: RunStatus; outcome?: unknown; summary?: string }) {
    const { count } = await this.db.run.updateMany({
      where: { id, tenantId },
      data: { ...(patch.status ? { status: patch.status } : {}), ...(patch.outcome !== undefined ? { outcome: json(patch.outcome) } : {}), ...(patch.summary !== undefined ? { summary: patch.summary } : {}) },
    })
    if (count !== 1) throw new Error(`Run ${id} not found in tenant ${tenantId}`)
  }

  async record(row: AuditRow): Promise<string> {
    const r = await this.db.toolCall.create({
      data: {
        runId: row.runId,
        tenantId: row.tenantId,
        principalId: row.principalId,
        server: row.server,
        tool: row.tool,
        node: row.node ?? null,
        args: json(row.args ?? {})!,
        ok: row.ok,
        error: row.error ?? null,
        ...(row.result !== undefined ? { result: json(row.result) } : {}),
        latencyMs: row.latencyMs,
        inputTokens: row.inputTokens ?? null,
        outputTokens: row.outputTokens ?? null,
        modelTurnId: row.modelTurnId ?? null,
        traceId: row.traceId ?? null,
        startedAt: new Date(row.startedAt),
      },
    })
    return r.id
  }

  async getRun(tenantId: string, id: string) {
    return this.db.run.findFirst({
      where: { id, tenantId },
      include: { toolCalls: { orderBy: { startedAt: 'asc' } }, plans: { include: { approval: true }, orderBy: { createdAt: 'asc' } } },
    })
  }

  async listRuns(tenantId: string, opts: { status?: RunStatus[]; take?: number } = {}) {
    return this.db.run.findMany({
      where: { tenantId, ...(opts.status ? { status: { in: opts.status } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: opts.take ?? 100,
    })
  }

  /** Token and latency totals for a run. Tokens sum over model turns only (see schema note). */
  async runUsage(tenantId: string, runId: string) {
    const [model, tools] = await Promise.all([
      this.db.toolCall.aggregate({ where: { tenantId, runId, server: 'model' }, _sum: { inputTokens: true, outputTokens: true, latencyMs: true }, _count: true }),
      this.db.toolCall.aggregate({ where: { tenantId, runId, server: { in: ['distru', 'workspace'] } }, _sum: { latencyMs: true }, _count: true }),
    ])
    return {
      modelTurns: model._count,
      inputTokens: model._sum.inputTokens ?? 0,
      outputTokens: model._sum.outputTokens ?? 0,
      modelLatencyMs: model._sum.latencyMs ?? 0,
      toolCalls: tools._count,
      toolLatencyMs: tools._sum.latencyMs ?? 0,
    }
  }
}

/** Loads a principal and its grants from the database, scoped to the tenant. */
export async function loadPrincipal(db: Db, tenantId: string, id: string): Promise<Principal | undefined> {
  const p = await db.principal.findFirst({ where: { id, tenantId }, include: { grants: true } })
  if (!p) return undefined
  return definePrincipal({ id: p.id, tenantId: p.tenantId, kind: p.kind, displayName: p.displayName, scopes: p.grants.map((g) => g.scope as Scope) })
}
