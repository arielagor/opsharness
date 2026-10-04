import type { DistruClient } from '@opsharness/distru-client'
import { DistruApiError, pointerToString } from '@opsharness/distru-client'
import type { Principal } from '@opsharness/core'
import { requireScope } from '@opsharness/core'
import type { AppliedResult, Plan, PlanStore } from './plans.js'

export class ApplyError extends Error {}

export interface ApplyOutcome {
  plan_id: string
  status: Plan['status']
  /** True when the plan had already been applied and this call returned the stored result. */
  replayed: boolean
  result?: AppliedResult
  error?: string
}

/**
 * Executes an APPROVED plan exactly once.
 *  1. the approval must exist, match the plan hash, and acknowledge deletions if destructive,
 *  2. a conditional APPROVED -> APPLYING claim makes concurrent or repeated calls safe,
 *  3. the order must not have changed since the plan was computed (otherwise FAILED, re-propose),
 *  4. the stored request is sent verbatim; the plan becomes APPLIED or FAILED.
 * A second call on an APPLIED plan returns the stored result and sends nothing.
 */
export async function applyPlan(client: DistruClient, plans: PlanStore, principal: Principal, planId: string, now: () => Date): Promise<ApplyOutcome> {
  requireScope(principal, 'orders:apply')
  const plan = await plans.get(principal.tenantId, planId)
  if (!plan) throw new ApplyError('Plan not found.')
  if (plan.status === 'APPLIED') return { plan_id: plan.id, status: plan.status, replayed: true, ...(plan.result ? { result: plan.result } : {}) }

  const approval = await plans.approvalFor(principal.tenantId, planId)
  if (!approval || approval.decision !== 'APPROVED') throw new ApplyError(`Plan is ${plan.status}: it has no recorded human approval.`)
  if (approval.planHash !== plan.hash) throw new ApplyError('The recorded approval is for a different plan hash.')
  if (plan.destructive && !approval.acknowledgeDestructive) throw new ApplyError('Destructive plan approved without acknowledging the deletions.')

  const claim = await plans.claimForApply(principal.tenantId, planId)
  if (claim.kind === 'already-applied') return { plan_id: plan.id, status: 'APPLIED', replayed: true, ...(claim.plan.result ? { result: claim.plan.result } : {}) }
  if (claim.kind === 'refused') throw new ApplyError(`Plan cannot be applied: ${claim.reason}.`)

  try {
    if (plan.orderId) {
      const current = await client.getOrder(plan.orderId)
      if (current.updated_datetime !== plan.baseUpdatedDatetime) {
        const failed = await plans.finishApply(principal.tenantId, planId, {
          ok: false,
          error: `Stale plan: order changed at ${current.updated_datetime} after the plan was computed (${plan.baseUpdatedDatetime}). Propose again.`,
        })
        return { plan_id: plan.id, status: failed.status, replayed: false, ...(failed.error ? { error: failed.error } : {}) }
      }
    }
    const order = await client.upsertOrder(plan.request)
    const result: AppliedResult = {
      order_id: order.id,
      order_number: order.order_number ?? '',
      status: order.status,
      line_count: order.items?.length ?? 0,
      total: String(order.total ?? ''),
      applied_at: now().toISOString(),
    }
    const done = await plans.finishApply(principal.tenantId, planId, { ok: true, result })
    return { plan_id: plan.id, status: done.status, replayed: false, result }
  } catch (e) {
    const message =
      e instanceof DistruApiError ? `Distru ${e.status}: ${e.errors.map((x) => `${pointerToString(x.pointer)}: ${x.message}`).join('; ')}` : `Apply failed: ${(e as Error).message}`
    const failed = await plans.finishApply(principal.tenantId, planId, { ok: false, error: message })
    return { plan_id: plan.id, status: failed.status, replayed: false, error: message }
  }
}
