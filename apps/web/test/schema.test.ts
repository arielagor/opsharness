import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, PrismaPlanStore, RunStore, seedPrincipals } from '@opsharness/db'
import { contextFor, execute, makeYoga } from '../src/lib/schema'

/**
 * The console's GraphQL schema against real Postgres. Rows are inserted directly (SYNTHETIC) so
 * the test does not depend on the harness.
 */
const db = createDb()
const runs = new RunStore(db)
const plans = new PrismaPlanStore(db)
const runA = `run_web_${randomUUID()}`
const planA = `plan_web_${randomUUID()}`

const diff = {
  kind: 'update',
  order_id: 'o1',
  order_number: 'SO-1003',
  customer: { id: 'c1', name: 'Harborview Wellness [SYNTHETIC]' },
  header: [],
  lines: {
    added: [],
    changed: [{ line_id: 'l1', product_id: 'p1', product_name: 'Blue Dream 3.5g Flower', sku: 'BD-FL-35', quantity: 25, price: 25, changes: [{ field: 'quantity', from: 20, to: 25 }] }],
    kept: [],
    deleted: [{ line_id: 'l2', product_id: 'p2', product_name: 'Sour Diesel 0.5g Vape Cartridge', sku: 'SD-VC-05', quantity: 4, price: 22 }],
  },
  destructive: true,
  destructive_reasons: ['deletes line SD-VC-05 "Sour Diesel 0.5g Vape Cartridge" x4 @ 22.00 (line l2)'],
  summary: 'UPDATE SO-1003',
}

/** Through yoga, as the endpoint and the pages do; the viewer is fixed per yoga instance. */
async function run(viewer: string, source: string, variables: Record<string, unknown> = {}) {
  const yoga = makeYoga(() => contextFor(db, runs, plans, viewer))
  return execute<Record<string, unknown>>(yoga, source, variables)
}

beforeAll(async () => {
  await seedPrincipals(db)
  await runs.createRun({ id: runA, tenantId: 'tenant-a', sourceKind: 'email', sourceRef: '005-harborview-change-quantity', mode: 'scripted', model: 'scripted' })
  await runs.updateRun('tenant-a', runA, { status: 'AWAITING_APPROVAL', summary: 'Waiting for approval', outcome: { trail: ['supervisor -> intake'] } })
  await db.plan.create({
    data: { id: planA, tenantId: 'tenant-a', runId: runA, proposedBy: 'agent-erp@tenant-a', orderId: 'o1', baseUpdatedDatetime: null, request: {}, diff, destructive: true, rationale: 'test', hash: 'h1', status: 'PROPOSED', createdAt: new Date() },
  })
})

afterAll(async () => {
  await db.$disconnect()
})

describe('console GraphQL schema', () => {
  it('lists the destructive plan in the approvals inbox with its deleted line', async () => {
    const d = await run('human-approver@tenant-a', '{ approvals { id destructive destructiveReasons lines { deleted { sku } changed { sku changes { field from to } } } } }')
    const p = (d['approvals'] as { id: string; destructive: boolean; lines: { deleted: { sku: string }[] } }[]).find((x) => x.id === planA)
    expect(p).toMatchObject({ destructive: true, lines: { deleted: [{ sku: 'SD-VC-05' }] } })
  })

  it("returns null for another tenant's run and lists none of its plans", async () => {
    const d = await run('human-approver@tenant-b', `{ run(id: "${runA}") { id } approvals { id } }`)
    expect(d['run']).toBeNull()
    expect((d['approvals'] as { id: string }[]).some((p) => p.id === planA)).toBe(false)
  })

  it('refuses an approval that does not acknowledge the deletions, then records one that does', async () => {
    const mutation = 'mutation($ack: Boolean!) { decide(planId: "' + planA + '", planHash: "h1", decision: APPROVED, acknowledgeDestructive: $ack) { ok error } }'
    const refused = (await run('human-approver@tenant-a', mutation, { ack: false }))['decide'] as { ok: boolean; error: string }
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/destructive/i)
    const ok = (await run('human-approver@tenant-a', mutation, { ack: true }))['decide'] as { ok: boolean }
    expect(ok.ok).toBe(true)
    const audit = await db.toolCall.findMany({ where: { runId: runA, server: 'human' } })
    expect(audit).toHaveLength(1)
  })

  it('a principal without orders:approve cannot decide', async () => {
    await expect(run('agent-readonly@tenant-a', `mutation { decide(planId: "${planA}", planHash: "h1", decision: REJECTED, acknowledgeDestructive: false) { ok } }`)).rejects.toThrow(/orders:approve/)
  })
})
