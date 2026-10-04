import { randomUUID } from 'node:crypto'
import {
  checkDecision,
  DecisionError,
  type AppliedResult,
  type Approval,
  type ClaimResult,
  type DecisionInput,
  type Plan,
  type PlanDiff,
  type PlanStatus,
  type PlanStore,
} from '@opsharness/mcp-distru'
import type { OrderUpsertRequest } from '@opsharness/distru-contract'
import type { Db } from './client.js'
import type { Approval as ApprovalRow, Plan as PlanRow, Prisma } from './generated/prisma/client.js'

const json = (v: unknown) => v as Prisma.InputJsonValue

function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    tenantId: r.tenantId,
    proposedBy: r.proposedBy,
    runId: r.runId,
    orderId: r.orderId,
    baseUpdatedDatetime: r.baseUpdatedDatetime,
    request: r.request as unknown as OrderUpsertRequest,
    diff: r.diff as unknown as PlanDiff,
    destructive: r.destructive,
    rationale: r.rationale,
    hash: r.hash,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    ...(r.result ? { result: r.result as unknown as AppliedResult } : {}),
    ...(r.error ? { error: r.error } : {}),
  }
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    tenantId: r.tenantId,
    planId: r.planId,
    planHash: r.planHash,
    decision: r.decision,
    approverId: r.approverId,
    acknowledgeDestructive: r.acknowledgeDestructive,
    ...(r.note ? { note: r.note } : {}),
    decidedAt: r.decidedAt.toISOString(),
  }
}

export interface PrismaPlanStoreOptions {
  /** Test seam: runs inside the decision transaction after every write, before commit. */
  beforeDecisionCommit?: () => void | Promise<void>
}

/**
 * Postgres-backed PlanStore. Every query filters on tenant_id. A decision, the plan's status
 * change and the human audit row commit in ONE transaction, with the plan row locked so two
 * approvers racing on the same plan serialize. The apply claim is a conditional UPDATE, so
 * exactly one concurrent applier wins.
 */
export class PrismaPlanStore implements PlanStore {
  constructor(
    private readonly db: Db,
    private readonly opts: PrismaPlanStoreOptions = {},
  ) {}

  async create(plan: Plan): Promise<void> {
    await this.db.plan.create({
      data: {
        id: plan.id,
        tenantId: plan.tenantId,
        runId: plan.runId,
        proposedBy: plan.proposedBy,
        orderId: plan.orderId,
        baseUpdatedDatetime: plan.baseUpdatedDatetime,
        request: json(plan.request),
        diff: json(plan.diff),
        destructive: plan.destructive,
        rationale: plan.rationale,
        hash: plan.hash,
        status: plan.status,
        createdAt: new Date(plan.createdAt),
      },
    })
  }

  async get(tenantId: string, planId: string): Promise<Plan | undefined> {
    const r = await this.db.plan.findFirst({ where: { id: planId, tenantId } })
    return r ? toPlan(r) : undefined
  }

  async list(tenantId: string, filter: { status?: PlanStatus[]; runId?: string } = {}): Promise<Plan[]> {
    const rows = await this.db.plan.findMany({
      where: { tenantId, ...(filter.status ? { status: { in: filter.status } } : {}), ...(filter.runId ? { runId: filter.runId } : {}) },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(toPlan)
  }

  async approvalFor(tenantId: string, planId: string): Promise<Approval | undefined> {
    const r = await this.db.approval.findFirst({ where: { planId, tenantId } })
    return r ? toApproval(r) : undefined
  }

  async recordDecision(tenantId: string, input: DecisionInput): Promise<Approval> {
    const t0 = performance.now()
    const startedAt = new Date()
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM plans WHERE id = ${input.planId} AND tenant_id = ${tenantId} FOR UPDATE`
      const row = await tx.plan.findFirst({ where: { id: input.planId, tenantId } })
      const plan = row ? toPlan(row) : undefined
      checkDecision(plan, input)

      const approver = await tx.principal.findFirst({ where: { id: input.approverId, tenantId }, include: { grants: true } })
      if (!approver || approver.kind !== 'human' || !approver.grants.some((g) => g.scope === 'orders:approve')) {
        throw new DecisionError('Only a human principal with orders:approve in this account can decide a plan')
      }

      const created = await tx.approval.create({
        data: {
          id: `appr_${randomUUID()}`,
          planId: plan.id,
          tenantId,
          decision: input.decision,
          approverId: input.approverId,
          planHash: input.planHash,
          acknowledgeDestructive: input.acknowledgeDestructive,
          note: input.note ?? null,
          decidedAt: startedAt,
        },
      })
      await tx.plan.update({ where: { id: plan.id }, data: { status: input.decision } })
      await tx.toolCall.create({
        data: {
          runId: plan.runId,
          tenantId,
          principalId: input.approverId,
          server: 'human',
          tool: 'record_decision',
          args: json({ plan_id: plan.id, plan_hash: input.planHash, decision: input.decision, acknowledge_destructive: input.acknowledgeDestructive, note: input.note ?? null }),
          ok: true,
          result: json({ approval_id: created.id, plan_status: input.decision, destructive: plan.destructive }),
          latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
          startedAt,
        },
      })
      await this.opts.beforeDecisionCommit?.()
      return toApproval(created)
    })
  }

  async claimForApply(tenantId: string, planId: string): Promise<ClaimResult> {
    const { count } = await this.db.plan.updateMany({ where: { id: planId, tenantId, status: 'APPROVED' }, data: { status: 'APPLYING' } })
    const plan = await this.get(tenantId, planId)
    if (count === 1 && plan) return { kind: 'claimed', plan }
    if (!plan) return { kind: 'refused', reason: 'Plan not found' }
    if (plan.status === 'APPLIED') return { kind: 'already-applied', plan }
    return { kind: 'refused', reason: `Plan is ${plan.status}`, plan }
  }

  async finishApply(tenantId: string, planId: string, outcome: { ok: true; result: AppliedResult } | { ok: false; error: string }): Promise<Plan> {
    const { count } = await this.db.plan.updateMany({
      where: { id: planId, tenantId, status: 'APPLYING' },
      data: outcome.ok ? { status: 'APPLIED', result: json(outcome.result) } : { status: 'FAILED', error: outcome.error },
    })
    if (count !== 1) throw new Error('finishApply on a plan that is not APPLYING')
    return (await this.get(tenantId, planId))!
  }
}
