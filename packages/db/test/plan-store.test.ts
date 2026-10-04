import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { demoPrincipal } from '@opsharness/core'
import { TENANT_A, TENANT_B } from '@opsharness/distru-mock'
import { applyPlan, DecisionError, mockConnection, proposeOrderChange, type Plan } from '@opsharness/mcp-distru'
import { createDb, loadPrincipal, PrismaPlanStore, RunStore, seedPrincipals } from '../src/index.js'

// Needs Postgres with migrations applied (`pnpm db:up`; the package's test script runs
// `prisma migrate deploy` first). Every plan id is fresh, so runs never collide.
const db = createDb()
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const now = () => new Date(NOW)
const erp = demoPrincipal('agent-erp@tenant-a')
const applier = demoPrincipal('svc-applier@tenant-a')

beforeAll(async () => {
  await seedPrincipals(db)
})
afterAll(async () => {
  await db.$disconnect()
})

function world() {
  const conn = mockConnection({ now: () => NOW, sleep: async () => {} })
  const a = conn.mock!.tenants.get(TENANT_A)!
  return { conn, a, client: conn.clientFor(TENANT_A) }
}

async function propose(w: ReturnType<typeof world>, store: PrismaPlanStore, destructive: boolean, runId: string | null = null): Promise<Plan> {
  const input = destructive
    ? { order_id: w.a.keys['order:so-3']!, items: [{ line_id: w.a.keys['item:so-3:0']!, quantity: 25 }], rationale: 'customer asked for 25' }
    : { company_id: w.a.keys['company:cinder']!, items: [{ product_id: w.a.keys['product:bd-preroll']!, quantity: 5, price: 8 }], rationale: 'new order' }
  const plan = await proposeOrderChange(w.client, erp, input, { now, runId })
  await store.create(plan)
  return plan
}

const decide = (plan: Plan, over: Partial<{ approverId: string; acknowledgeDestructive: boolean; decision: 'APPROVED' | 'REJECTED'; planHash: string }> = {}) => ({
  planId: plan.id,
  planHash: plan.hash,
  decision: 'APPROVED' as const,
  approverId: 'human-approver@tenant-a',
  acknowledgeDestructive: plan.destructive,
  ...over,
})

describe('PrismaPlanStore', () => {
  it('round-trips a plan and scopes reads to the tenant', async () => {
    const store = new PrismaPlanStore(db)
    const plan = await propose(world(), store, true)
    const back = await store.get(TENANT_A, plan.id)
    expect(back).toEqual(plan)
    expect(await store.get(TENANT_B, plan.id)).toBeUndefined()
    expect((await store.list(TENANT_B)).some((p) => p.id === plan.id)).toBe(false)
  })

  it('approval, plan status and the human audit row commit together', async () => {
    const store = new PrismaPlanStore(db)
    const runs = new RunStore(db)
    const runId = `run_${randomUUID()}`
    await runs.createRun({ id: runId, tenantId: TENANT_A, sourceKind: 'email', sourceRef: 'test', mode: 'scripted', model: null })
    const plan = await propose(world(), store, true, runId)
    const approval = await store.recordDecision(TENANT_A, decide(plan))
    expect((await store.get(TENANT_A, plan.id))!.status).toBe('APPROVED')
    expect(await store.approvalFor(TENANT_A, plan.id)).toEqual(approval)
    const audit = await db.toolCall.findMany({ where: { runId, server: 'human' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.principalId).toBe('human-approver@tenant-a')
    expect(audit[0]!.result).toMatchObject({ approval_id: approval.id, plan_status: 'APPROVED', destructive: true })
  })

  it('a failure before commit leaves no approval, no audit row and the plan PROPOSED', async () => {
    const store = new PrismaPlanStore(db, {
      beforeDecisionCommit: () => {
        throw new Error('injected fault')
      },
    })
    const runId = `run_${randomUUID()}`
    await new RunStore(db).createRun({ id: runId, tenantId: TENANT_A, sourceKind: 'email', sourceRef: 'test', mode: 'scripted', model: null })
    const plan = await propose(world(), store, false, runId)
    await expect(store.recordDecision(TENANT_A, decide(plan))).rejects.toThrow('injected fault')
    expect((await store.get(TENANT_A, plan.id))!.status).toBe('PROPOSED')
    expect(await store.approvalFor(TENANT_A, plan.id)).toBeUndefined()
    expect(await db.toolCall.count({ where: { runId } })).toBe(0)
  })

  it('refuses agents, services, other tenants, a wrong hash and an unacknowledged deletion', async () => {
    const store = new PrismaPlanStore(db)
    const plan = await propose(world(), store, true)
    for (const approverId of ['agent-erp@tenant-a', 'svc-applier@tenant-a', 'human-approver@tenant-b']) {
      await expect(store.recordDecision(TENANT_A, decide(plan, { approverId }))).rejects.toThrow(DecisionError)
    }
    await expect(store.recordDecision(TENANT_A, decide(plan, { planHash: 'f'.repeat(64) }))).rejects.toThrow(/hash/)
    await expect(store.recordDecision(TENANT_A, decide(plan, { acknowledgeDestructive: false }))).rejects.toThrow(/deletes data/)
    await expect(store.recordDecision(TENANT_B, decide(plan, { approverId: 'human-approver@tenant-b' }))).rejects.toThrow('Plan not found')
    expect((await store.get(TENANT_A, plan.id))!.status).toBe('PROPOSED')
  })

  it('two racing decisions on one plan: exactly one wins', async () => {
    const store = new PrismaPlanStore(db)
    const plan = await propose(world(), store, false)
    const results = await Promise.allSettled([store.recordDecision(TENANT_A, decide(plan)), store.recordDecision(TENANT_A, decide(plan, { decision: 'REJECTED' }))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('applies exactly once under concurrency and replays afterwards', async () => {
    const store = new PrismaPlanStore(db)
    const w = world()
    const plan = await propose(w, store, false)
    await store.recordDecision(TENANT_A, decide(plan))
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => applyPlan(w.client, store, applier, plan.id, now)))
    expect(w.a.writes.length).toBe(1)
    expect(results.filter((r) => r.status === 'fulfilled' && !r.value.replayed)).toHaveLength(1)
    const again = await applyPlan(w.client, store, applier, plan.id, now)
    expect(again.replayed).toBe(true)
    expect(w.a.writes.length).toBe(1)
    expect((await store.get(TENANT_A, plan.id))!.status).toBe('APPLIED')
  })

  it('the audit tables are append-only at the database', async () => {
    const id = await new RunStore(db).record({ runId: null, tenantId: TENANT_A, principalId: 'agent-erp@tenant-a', server: 'distru', tool: 'search_products', args: {}, ok: true, latencyMs: 1, startedAt: new Date().toISOString() })
    await expect(db.toolCall.update({ where: { id }, data: { ok: false } })).rejects.toThrow(/append-only/)
    await expect(db.toolCall.delete({ where: { id } })).rejects.toThrow(/append-only/)
  })

  it('loads a principal with exactly its granted scopes', async () => {
    const p = await loadPrincipal(db, TENANT_A, 'agent-intake@tenant-a')
    expect([...p!.scopes].sort()).toEqual(['mail:read', 'products:read', 'sheets:read'])
    expect(await loadPrincipal(db, TENANT_B, 'agent-intake@tenant-a')).toBeUndefined()
  })
})
