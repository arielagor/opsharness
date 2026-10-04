import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_A } from '@opsharness/distru-mock'
import { createDb, seedPrincipals } from '@opsharness/db'
import { mockConnection } from '@opsharness/mcp-distru'
import { Harness, matchProduct, route, scriptedModels, type State } from '../src/index.js'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')

beforeAll(async () => {
  const db = createDb()
  await seedPrincipals(db)
  await db.$disconnect()
})

describe('matchProduct', () => {
  const catalog = [
    { product_id: '1', name: 'Sour Diesel 3.5g Flower', sku: 'SD-FL-35' },
    { product_id: '2', name: 'Sour Diesel 0.5g Vape Cartridge', sku: 'SD-VC-05' },
    { product_id: '3', name: 'Sour Diesel 1g Live Resin', sku: 'SD-LR-1' },
  ]
  it('a bare strain name is ambiguous; a SKU or an exact name is not', () => {
    expect(matchProduct({ description: 'Sour Diesel' }, catalog).kind).toBe('ambiguous')
    expect(matchProduct({ description: 'x', sku: 'sd-vc-05' }, catalog)).toMatchObject({ kind: 'unique', product: { product_id: '2' } })
    expect(matchProduct({ description: 'Sour Diesel 1g Live Resin' }, catalog)).toMatchObject({ kind: 'unique', product: { product_id: '3' } })
    expect(matchProduct({ description: 'Blue Dream' }, catalog).kind).toBe('none')
  })
})

describe('supervisor routing', () => {
  const base = { runId: 'r', tenantId: 't', source: { kind: 'email', ref: 'x' }, draft: null, injectionSuspected: false, clarification: null, proposal: null, verdict: null, decision: null, applyResult: null, pdf: null, failure: null, outcome: null, trail: [] } as State
  it('never routes to apply without an APPROVED decision', () => {
    const verified = { ...base, draft: { intent: 'new_order', lines: [], source_quote: '' }, proposal: { planId: 'p', planHash: 'h', destructive: false, destructiveReasons: [], summary: '' }, verdict: { ok: true, needsClarification: false, blockers: [], warnings: [], checks: [] } } as State
    expect(route(verified)).toBe('approval_gate')
    expect(route({ ...verified, decision: 'REJECTED' })).toBe('finish')
    expect(route({ ...verified, decision: 'APPROVED' })).toBe('apply')
    expect(route({ ...verified, verdict: { ...verified.verdict!, ok: false } })).toBe('finish')
  })
})

describe('harness end to end (scripted model, mock Distru, real Postgres)', () => {
  let harness: Harness
  const conn = mockConnection({ now: () => NOW, sleep: async () => {} })
  beforeAll(async () => {
    harness = await Harness.create({ connection: conn, ...scriptedModels(), now: () => new Date(NOW) })
  })
  afterAll(async () => {
    await harness.close()
  })

  it('a clean email order stops at approval, then applies once', async () => {
    const a = conn.mock!.tenants.get(TENANT_A)!
    const before = a.writes.length
    const r = await harness.start(TENANT_A, { kind: 'email', ref: '001-harborview-new-order' })
    expect(r.status).toBe('AWAITING_APPROVAL')
    expect(a.writes.length).toBe(before)
    const p = r.state.proposal!
    await harness.plans.recordDecision(TENANT_A, { planId: p.planId, planHash: p.planHash, decision: 'APPROVED', approverId: 'human-approver@tenant-a', acknowledgeDestructive: false })
    const done = await harness.resume(TENANT_A, r.runId)
    expect(done.status).toBe('APPLIED')
    expect(a.writes.length).toBe(before + 1)
    const run = await harness.runs.getRun(TENANT_A, r.runId)
    expect(run!.toolCalls.some((c) => c.server === 'model' && (c.inputTokens ?? 0) > 0)).toBe(true)
    expect(run!.toolCalls.some((c) => c.server === 'human' && c.tool === 'record_decision')).toBe(true)
  })
})
