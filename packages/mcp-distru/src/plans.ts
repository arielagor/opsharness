import { createHash, randomUUID } from 'node:crypto'
import type { OrderUpsertRequest } from '@opsharness/distru-contract'

/**
 * A write PLAN: the exact Distru request that would be sent, the order state it was computed
 * against, and a semantic diff a human can read. Plans are immutable once proposed; the only
 * thing that changes is `status`. See docs/decisions/0001-two-phase-writes.md.
 */

export type PlanStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'APPLYING' | 'APPLIED' | 'FAILED'

export interface LineView {
  line_id: string | null
  product_id: string
  product_name: string
  sku: string
  quantity: number
  price: number
}

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

export interface PlanDiff {
  kind: 'create' | 'update'
  order_id: string | null
  order_number: string | null
  customer: { id: string; name: string } | null
  header: FieldChange[]
  lines: {
    added: LineView[]
    changed: (LineView & { changes: FieldChange[] })[]
    kept: LineView[]
    deleted: LineView[]
  }
  destructive: boolean
  /** One sentence per destructive effect, naming the row. Empty when not destructive. */
  destructive_reasons: string[]
  /** Plain-text rendering for logs and the approval inbox. */
  summary: string
}

export interface Plan {
  id: string
  tenantId: string
  proposedBy: string
  runId: string | null
  orderId: string | null
  /** The order's updated_datetime when the plan was computed; null for a create. */
  baseUpdatedDatetime: string | null
  request: OrderUpsertRequest
  diff: PlanDiff
  destructive: boolean
  rationale: string
  hash: string
  status: PlanStatus
  createdAt: string
  result?: AppliedResult
  error?: string
}

export interface AppliedResult {
  order_id: string
  order_number: string
  status: string
  line_count: number
  total: string
  applied_at: string
}

export type Decision = 'APPROVED' | 'REJECTED'

export interface DecisionInput {
  planId: string
  /** The hash the approver saw. A mismatch means they approved something else. */
  planHash: string
  decision: Decision
  approverId: string
  /** Required to approve a destructive plan: the human ticked "I see the deletions". */
  acknowledgeDestructive: boolean
  note?: string
}

export interface Approval extends DecisionInput {
  id: string
  tenantId: string
  decidedAt: string
}

export type ClaimResult = { kind: 'claimed'; plan: Plan } | { kind: 'already-applied'; plan: Plan } | { kind: 'refused'; reason: string; plan?: Plan }

/**
 * Persistence for plans and decisions. Every method takes the tenant: a plan id from another
 * tenant behaves exactly like an id that does not exist.
 */
export interface PlanStore {
  create(plan: Plan): Promise<void>
  get(tenantId: string, planId: string): Promise<Plan | undefined>
  list(tenantId: string, filter?: { status?: PlanStatus[]; runId?: string }): Promise<Plan[]>
  approvalFor(tenantId: string, planId: string): Promise<Approval | undefined>
  /** Records a human decision. Implementations write the audit row in the same transaction. */
  recordDecision(tenantId: string, input: DecisionInput): Promise<Approval>
  /** Atomically moves APPROVED to APPLYING. Exactly one concurrent caller wins. */
  claimForApply(tenantId: string, planId: string): Promise<ClaimResult>
  finishApply(tenantId: string, planId: string, outcome: { ok: true; result: AppliedResult } | { ok: false; error: string }): Promise<Plan>
}

export class DecisionError extends Error {}

/** Shared validation for recordDecision, used by every PlanStore implementation. */
export function checkDecision(plan: Plan | undefined, input: DecisionInput): asserts plan is Plan {
  if (!plan) throw new DecisionError('Plan not found')
  if (plan.status !== 'PROPOSED') throw new DecisionError(`Plan is ${plan.status}; only a PROPOSED plan can be decided`)
  if (input.planHash !== plan.hash) throw new DecisionError('Plan hash does not match: the approver reviewed a different plan')
  if (input.decision === 'APPROVED' && plan.destructive && !input.acknowledgeDestructive) {
    throw new DecisionError('This plan deletes data. Approving it requires acknowledging the destructive changes.')
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

export function planHash(p: Pick<Plan, 'tenantId' | 'orderId' | 'baseUpdatedDatetime' | 'request'>): string {
  const body = JSON.stringify(canonical({ tenantId: p.tenantId, orderId: p.orderId, base: p.baseUpdatedDatetime, request: p.request }))
  return createHash('sha256').update(body).digest('hex')
}

export function newPlanId(): string {
  return `plan_${randomUUID()}`
}

export class InMemoryPlanStore implements PlanStore {
  private plans = new Map<string, Plan>()
  private approvals = new Map<string, Approval>()

  private key(tenantId: string, planId: string) {
    return `${tenantId}\u0000${planId}`
  }

  async create(plan: Plan) {
    this.plans.set(this.key(plan.tenantId, plan.id), structuredClone(plan))
  }

  async get(tenantId: string, planId: string) {
    const p = this.plans.get(this.key(tenantId, planId))
    return p ? structuredClone(p) : undefined
  }

  async list(tenantId: string, filter: { status?: PlanStatus[]; runId?: string } = {}) {
    return [...this.plans.values()]
      .filter((p) => p.tenantId === tenantId && (!filter.status || filter.status.includes(p.status)) && (!filter.runId || p.runId === filter.runId))
      .map((p) => structuredClone(p))
  }

  async approvalFor(tenantId: string, planId: string) {
    const a = this.approvals.get(this.key(tenantId, planId))
    return a ? structuredClone(a) : undefined
  }

  async recordDecision(tenantId: string, input: DecisionInput) {
    const plan = this.plans.get(this.key(tenantId, input.planId))
    checkDecision(plan, input)
    const approval: Approval = { ...input, id: `appr_${randomUUID()}`, tenantId, decidedAt: new Date().toISOString() }
    this.approvals.set(this.key(tenantId, input.planId), approval)
    plan.status = input.decision
    return structuredClone(approval)
  }

  async claimForApply(tenantId: string, planId: string): Promise<ClaimResult> {
    // Synchronous check-and-set: no await between read and write, so it is atomic in-process.
    const plan = this.plans.get(this.key(tenantId, planId))
    if (!plan) return { kind: 'refused', reason: 'Plan not found' }
    if (plan.status === 'APPLIED') return { kind: 'already-applied', plan: structuredClone(plan) }
    if (plan.status !== 'APPROVED') return { kind: 'refused', reason: `Plan is ${plan.status}`, plan: structuredClone(plan) }
    plan.status = 'APPLYING'
    return { kind: 'claimed', plan: structuredClone(plan) }
  }

  async finishApply(tenantId: string, planId: string, outcome: { ok: true; result: AppliedResult } | { ok: false; error: string }) {
    const plan = this.plans.get(this.key(tenantId, planId))
    if (!plan || plan.status !== 'APPLYING') throw new Error(`finishApply on a plan that is not APPLYING`)
    if (outcome.ok) {
      plan.status = 'APPLIED'
      plan.result = outcome.result
    } else {
      plan.status = 'FAILED'
      plan.error = outcome.error
    }
    return structuredClone(plan)
  }
}
