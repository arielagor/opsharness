import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { Annotation, END, interrupt, isGraphInterrupt, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph'
import type { Principal } from '@opsharness/core'
import { loadPrincipal, type Db, type RunStore } from '@opsharness/db'
import { buildDistruMcpServer, type DistruConnection, type PlanStore } from '@opsharness/mcp-distru'
import { buildWorkspaceMcpServer } from '@opsharness/mcp-workspace'
import { log, withSpan } from '@opsharness/telemetry'
import { runSpecialist } from './agent-loop.js'
import { ERP_SYSTEM, erpTask, INTAKE_SYSTEM, intakeTask, REQUEST_CLARIFICATION, SUBMIT_DRAFT, SUBMIT_PROPOSAL } from './prompts.js'
import { openToolbox, type Toolbox } from './toolbox.js'
import type { ApplyView, OrderDraft, Outcome, Proposal, Source, Verdict } from './types.js'
import { verify } from './verifier.js'

const last = <T>() => Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => null as T })

export const RunState = Annotation.Root({
  runId: Annotation<string>(),
  tenantId: Annotation<string>(),
  source: Annotation<Source>(),
  draft: last<OrderDraft | null>(),
  injectionSuspected: Annotation<boolean>({ reducer: (a, b) => a || b, default: () => false }),
  clarification: last<string | null>(),
  proposal: last<Proposal | null>(),
  verdict: last<Verdict | null>(),
  decision: last<'APPROVED' | 'REJECTED' | null>(),
  applyResult: last<ApplyView | null>(),
  pdf: last<{ url: string | null; error?: string } | null>(),
  failure: last<string | null>(),
  outcome: last<Outcome | null>(),
  trail: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
})

export type State = typeof RunState.State
type Update = typeof RunState.Update

export type Role = 'intake' | 'erp'

export interface GraphDeps {
  db: Db
  runs: RunStore
  plans: PlanStore
  connection: DistruConnection
  model: (role: Role) => BaseChatModel
  modelName: string
  now: () => Date
  workspaceRoot?: string
  maxTurns?: number
}

const NODES = ['intake', 'erp', 'verifier', 'approval_gate', 'apply', 'finish'] as const
type NodeName = (typeof NODES)[number]

/** The supervisor's routing rule. Deterministic: models do work inside nodes, never pick the next step. */
export function route(s: State): NodeName {
  if (s.failure || s.clarification) return 'finish'
  if (!s.draft) return 'intake'
  if (!s.proposal) return 'erp'
  if (!s.verdict) return 'verifier'
  if (!s.verdict.ok) return 'finish'
  if (!s.decision) return 'approval_gate'
  if (s.decision === 'REJECTED') return 'finish'
  if (!s.applyResult) return 'apply'
  return 'finish'
}

export function outcomeOf(s: State): Outcome {
  if (s.failure) return 'FAILED'
  if (s.clarification) return 'NEEDS_CLARIFICATION'
  if (s.verdict && !s.verdict.ok) return s.verdict.needsClarification ? 'NEEDS_CLARIFICATION' : 'BLOCKED'
  if (s.decision === 'REJECTED') return 'REJECTED'
  if (s.applyResult?.ok) return 'APPLIED'
  return 'FAILED'
}

export function buildGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const maxTurns = deps.maxTurns ?? 12

  async function principal(s: State, role: string): Promise<Principal> {
    const p = await loadPrincipal(deps.db, s.tenantId, `${role}@${s.tenantId}`)
    if (!p) throw new Error(`No principal ${role}@${s.tenantId}`)
    return p
  }

  async function distru(s: State, role: string): Promise<Toolbox> {
    const p = await principal(s, role)
    const server = buildDistruMcpServer({ principal: p, client: deps.connection.clientFor(s.tenantId), plans: deps.plans, now: deps.now, runId: s.runId })
    return openToolbox({ server, serverName: 'distru', principal: p, runId: s.runId, audit: (r) => deps.runs.record(r) })
  }

  async function workspace(s: State, role: string): Promise<Toolbox> {
    const p = await principal(s, role)
    const server = buildWorkspaceMcpServer({ principal: p, runId: s.runId, ...(deps.workspaceRoot ? { root: deps.workspaceRoot } : {}) })
    return openToolbox({ server, serverName: 'workspace', principal: p, runId: s.runId, audit: (r) => deps.runs.record(r) })
  }

  async function using<T>(tb: Toolbox, fn: (tb: Toolbox) => Promise<T>): Promise<T> {
    try {
      return await fn(tb)
    } finally {
      await tb.close()
    }
  }

  /** Every node is a span with the run id on it. */
  const node =
    (name: string, fn: (s: State) => Promise<Update>) =>
    (s: State): Promise<Update> =>
      withSpan(`graph.node ${name}`, { 'graph.node': name, 'opsharness.run_id': s.runId }, () => fn(s), { expected: isGraphInterrupt })

  const supervisor = async (s: State): Promise<Update> => ({ trail: [`supervisor -> ${route(s)}`] })

  const intake = async (s: State): Promise<Update> =>
    using(await workspace(s, 'agent-intake'), async (tb) => {
      const r = await runSpecialist({ node: 'intake', model: deps.model('intake'), modelName: deps.modelName, system: INTAKE_SYSTEM, task: intakeTask(s.source), toolbox: tb, terminal: [SUBMIT_DRAFT, REQUEST_CLARIFICATION], maxTurns, runId: s.runId, audit: (row) => deps.runs.record(row) })
      const injectionSuspected = r.observations.some((o) => o.data['injection_suspected'] === true)
      if (!r.terminal) return { failure: `intake did not finish within ${maxTurns} turns`, injectionSuspected, trail: ['intake: no result'] }
      if (r.terminal.name === 'request_clarification') return { clarification: String(r.terminal.args['question'] ?? ''), injectionSuspected, trail: ['intake: asked for clarification'] }
      const draft = r.terminal.args as unknown as OrderDraft
      if (!Array.isArray(draft.lines) || draft.lines.length === 0) return { failure: 'intake returned a draft with no lines', injectionSuspected }
      return { draft, injectionSuspected, trail: [`intake: ${draft.lines.length} line(s), intent ${draft.intent}`] }
    })

  const erp = async (s: State): Promise<Update> =>
    using(await distru(s, 'agent-erp'), async (tb) => {
      const r = await runSpecialist({ node: 'erp', model: deps.model('erp'), modelName: deps.modelName, system: ERP_SYSTEM, task: erpTask(s.draft!), toolbox: tb, terminal: [SUBMIT_PROPOSAL, REQUEST_CLARIFICATION], maxTurns, runId: s.runId, audit: (row) => deps.runs.record(row) })
      if (!r.terminal) return { failure: `erp did not finish within ${maxTurns} turns`, trail: ['erp: no result'] }
      if (r.terminal.name === 'request_clarification') return { clarification: String(r.terminal.args['question'] ?? ''), trail: ['erp: asked for clarification'] }
      const planId = String(r.terminal.args['plan_id'] ?? '')
      const plan = await deps.plans.get(s.tenantId, planId)
      // The model names a plan; the harness only accepts one proposed in THIS run and still open.
      if (!plan || plan.runId !== s.runId || plan.status !== 'PROPOSED') return { failure: `erp submitted plan ${planId}, which is not an open plan from this run`, trail: ['erp: invalid plan'] }
      return {
        proposal: { planId: plan.id, planHash: plan.hash, destructive: plan.destructive, destructiveReasons: plan.diff.destructive_reasons, summary: plan.diff.summary },
        trail: [`erp: proposed ${plan.id}${plan.destructive ? ' (DESTRUCTIVE)' : ''}`],
      }
    })

  const verifier = async (s: State): Promise<Update> =>
    using(await distru(s, 'svc-verifier'), async (tb) => {
      const plan = (await deps.plans.get(s.tenantId, s.proposal!.planId))!
      const verdict = await verify({ draft: s.draft!, plan, toolbox: tb, injectionSuspected: s.injectionSuspected })
      return { verdict, trail: [`verifier: ${verdict.ok ? 'pass' : `${verdict.blockers.length} blocker(s)`}${verdict.warnings.length ? `, ${verdict.warnings.length} warning(s)` : ''}`] }
    })

  const approvalGate = async (s: State): Promise<Update> => {
    const p = s.proposal!
    // Execution stops here until a worker resumes the thread. Nothing before this line has side effects.
    interrupt({ kind: 'approval', run_id: s.runId, plan_id: p.planId, plan_hash: p.planHash, destructive: p.destructive, summary: p.summary, warnings: s.verdict?.warnings ?? [] })
    // The resume value is only a nudge; the recorded approval is the source of truth.
    const approval = await deps.plans.approvalFor(s.tenantId, p.planId)
    if (!approval) return { trail: ['approval_gate: resumed without a recorded decision; waiting again'] }
    if (approval.planHash !== p.planHash) return { failure: 'approval is for a different plan hash', trail: ['approval_gate: hash mismatch'] }
    return { decision: approval.decision, trail: [`approval_gate: ${approval.decision} by ${approval.approverId}`] }
  }

  const apply = async (s: State): Promise<Update> =>
    using(await distru(s, 'svc-applier'), async (tb) => {
      const r = await tb.call('apply_plan', { plan_id: s.proposal!.planId }, { node: 'apply' })
      const result = r.data['result'] as { order_id: string; order_number: string; total: string } | undefined
      if (r.isError || r.data['status'] !== 'APPLIED' || !result) {
        return { applyResult: { ok: false, error: r.isError ? r.text : String(r.data['error'] ?? r.data['status']) }, trail: ['apply: failed'] }
      }
      const applyResult: ApplyView = { ok: true, orderId: result.order_id, orderNumber: result.order_number, total: result.total, replayed: Boolean(r.data['replayed']) }
      // The order PDF link: Distru rate-limits this endpoint; the client waits out Retry-After.
      const pdf = await tb.call('get_order_pdf', { order_id: result.order_id }, { node: 'apply' })
      return {
        applyResult,
        pdf: pdf.isError ? { url: null, error: pdf.text } : { url: (pdf.data['pdf_url'] as string | null) ?? null },
        trail: [`apply: ${result.order_number} written${applyResult.replayed ? ' (replayed)' : ''}`],
      }
    })

  const finish = async (s: State): Promise<Update> => {
    const outcome = outcomeOf(s)
    log.info('run finished', { outcome })
    return { outcome, trail: [`finish: ${outcome}`] }
  }

  return new StateGraph(RunState)
    .addNode('supervisor', node('supervisor', supervisor))
    .addNode('intake', node('intake', intake))
    .addNode('erp', node('erp', erp))
    .addNode('verifier', node('verifier', verifier))
    .addNode('approval_gate', node('approval_gate', approvalGate))
    .addNode('apply', node('apply', apply))
    .addNode('finish', node('finish', finish))
    .addEdge(START, 'supervisor')
    .addConditionalEdges('supervisor', route, [...NODES])
    .addEdge('intake', 'supervisor')
    .addEdge('erp', 'supervisor')
    .addEdge('verifier', 'supervisor')
    .addEdge('approval_gate', 'supervisor')
    .addEdge('apply', 'supervisor')
    .addEdge('finish', END)
    .compile({ checkpointer })
}
