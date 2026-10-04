import { randomUUID } from 'node:crypto'
import { Command } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { createDb, databaseUrl, PrismaPlanStore, RunStore, type Db, type RunStatus } from '@opsharness/db'
import type { DistruConnection } from '@opsharness/mcp-distru'
import { log, withRunContext, withSpan } from '@opsharness/telemetry'
import { buildGraph, outcomeOf, type GraphDeps, type Role, type State } from './graph.js'
import type { Source } from './types.js'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

export interface HarnessOptions {
  connection: DistruConnection
  model: (role: Role) => BaseChatModel
  /** Recorded on every run and model audit row. "scripted" for the deterministic model. */
  modelName: string
  mode: 'scripted' | 'live'
  databaseUrl?: string
  now?: () => Date
  workspaceRoot?: string
  maxTurns?: number
  /** Postgres schema for the LangGraph checkpoint tables. */
  checkpointSchema?: string
}

export interface RunSummary {
  runId: string
  tenantId: string
  status: RunStatus
  state: State
}

const STATUS: Record<ReturnType<typeof outcomeOf>, RunStatus> = {
  APPLIED: 'APPLIED',
  REJECTED: 'REJECTED',
  BLOCKED: 'BLOCKED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  FAILED: 'FAILED',
}

/**
 * Owns the compiled graph, its Postgres checkpointer and the stores. A run's progress lives only
 * in Postgres (checkpoints + tables), so a new Harness in a new process can resume any run.
 */
export class Harness {
  private constructor(
    readonly db: Db,
    readonly runs: RunStore,
    readonly plans: PrismaPlanStore,
    private readonly checkpointer: PostgresSaver,
    private readonly graph: ReturnType<typeof buildGraph>,
    private readonly opts: HarnessOptions,
  ) {}

  static async create(opts: HarnessOptions): Promise<Harness> {
    const url = opts.databaseUrl ?? databaseUrl()
    const db = createDb(url)
    const runs = new RunStore(db)
    const plans = new PrismaPlanStore(db)
    const checkpointer = PostgresSaver.fromConnString(url, { schema: opts.checkpointSchema ?? 'langgraph' })
    await checkpointer.setup()
    const deps: GraphDeps = {
      db,
      runs,
      plans,
      connection: opts.connection,
      model: opts.model,
      modelName: opts.modelName,
      now: opts.now ?? (() => new Date()),
      ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    }
    return new Harness(db, runs, plans, checkpointer, buildGraph(deps, checkpointer), opts)
  }

  private config(runId: string) {
    return { configurable: { thread_id: runId }, recursionLimit: 60 }
  }

  /** Starts a run and drives it until it finishes or stops at the approval gate. */
  async start(tenantId: string, source: Source): Promise<RunSummary> {
    const runId = `run_${randomUUID()}`
    await this.runs.createRun({ id: runId, tenantId, sourceKind: source.kind, sourceRef: source.ref, mode: this.opts.mode, model: this.opts.modelName })
    return this.drive(tenantId, runId, { runId, tenantId, source })
  }

  /**
   * Continues a run parked at the approval gate. Safe to call twice or from two workers: the gate
   * re-reads the recorded decision and apply_plan is idempotent per plan.
   */
  async resume(tenantId: string, runId: string): Promise<RunSummary> {
    const run = await this.runs.getRun(tenantId, runId)
    if (!run) throw new Error(`Run ${runId} not found`)
    if (run.status !== 'AWAITING_APPROVAL') return { runId, tenantId, status: run.status, state: (await this.graph.getState(this.config(runId))).values as State }
    return this.drive(tenantId, runId, new Command({ resume: { by: 'worker' } }))
  }

  /** One worker pass: resumes every run whose plan now has a recorded human decision. */
  async resumeDecided(tenantId?: string): Promise<RunSummary[]> {
    const waiting = await this.db.run.findMany({
      where: { status: 'AWAITING_APPROVAL', ...(tenantId ? { tenantId } : {}), plans: { some: { approval: { isNot: null } } } },
      select: { id: true, tenantId: true },
    })
    const out: RunSummary[] = []
    for (const r of waiting) out.push(await this.resume(r.tenantId, r.id))
    return out
  }

  private async drive(tenantId: string, runId: string, input: Parameters<ReturnType<typeof buildGraph>['invoke']>[0]): Promise<RunSummary> {
    return withRunContext({ runId, tenantId }, () =>
      withSpan('graph.run', { 'opsharness.run_id': runId, 'opsharness.tenant_id': tenantId, 'opsharness.mode': this.opts.mode }, async (span) => {
        try {
          await this.graph.invoke(input, this.config(runId))
        } catch (e) {
          log.error('run crashed', { err: (e as Error).stack })
          await this.runs.updateRun(tenantId, runId, { status: 'FAILED', summary: `Run crashed: ${(e as Error).message}` })
          throw e
        }
        const snap = await this.graph.getState(this.config(runId))
        const state = snap.values as State
        const waiting = snap.tasks.some((t) => (t.interrupts ?? []).length > 0)
        const status: RunStatus = waiting ? 'AWAITING_APPROVAL' : STATUS[state.outcome ?? outcomeOf(state)]
        span.setAttribute('opsharness.run_status', status)
        await this.runs.updateRun(tenantId, runId, { status, outcome: summarize(state), summary: describe(status, state) })
        log.info('run step complete', { status })
        return { runId, tenantId, status, state }
      }),
    )
  }

  async close(): Promise<void> {
    await this.checkpointer.end()
    await this.db.$disconnect()
  }
}

function summarize(s: State) {
  return {
    draft: s.draft,
    proposal: s.proposal,
    verdict: s.verdict,
    decision: s.decision,
    apply: s.applyResult,
    pdf: s.pdf,
    clarification: s.clarification,
    failure: s.failure,
    injection_suspected: s.injectionSuspected,
    trail: s.trail,
  }
}

function describe(status: RunStatus, s: State): string {
  switch (status) {
    case 'AWAITING_APPROVAL':
      return `Waiting for approval: ${s.proposal?.destructive ? 'DESTRUCTIVE plan, ' : ''}${s.proposal?.planId}`
    case 'APPLIED':
      return `Applied as ${s.applyResult?.orderNumber} (total ${s.applyResult?.total})`
    case 'BLOCKED':
      return `Blocked: ${s.verdict?.blockers.join(' ')}`
    case 'NEEDS_CLARIFICATION':
      return `Needs clarification: ${s.clarification ?? s.verdict?.blockers.join(' ')}`
    case 'REJECTED':
      return 'Rejected by a human; nothing was written.'
    case 'FAILED':
      return `Failed: ${s.failure ?? s.applyResult?.error ?? 'unknown'}`
    default:
      return status
  }
}
