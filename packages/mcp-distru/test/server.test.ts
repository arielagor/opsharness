import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { demoPrincipal, type ToolCallEvent } from '@opsharness/core'
import { TENANT_A, TENANT_B } from '@opsharness/distru-mock'
import { buildDistruMcpServer, DecisionError, InMemoryPlanStore, mockConnection, type DistruConnection, type PlanStore } from '../src/index.js'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')

function world() {
  const conn = mockConnection({ now: () => NOW, sleep: async () => {} })
  const plans = new InMemoryPlanStore()
  const events: ToolCallEvent[] = []
  const a = conn.mock!.tenants.get(TENANT_A)!
  const b = conn.mock!.tenants.get(TENANT_B)!
  return { conn, plans, events, a, b }
}

async function connect(principalId: string, conn: DistruConnection, plans: PlanStore, events: ToolCallEvent[] = []) {
  const principal = demoPrincipal(principalId)
  const server = buildDistruMcpServer({ principal, client: conn.clientFor(principal.tenantId), plans, now: () => new Date(NOW), onToolCall: (e) => void events.push(e) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? ''
    return { isError: Boolean(r.isError), text, data: (r.structuredContent ?? {}) as Record<string, unknown> }
  }
  return { client, call, principal }
}

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort()

describe('per-principal tool listing', () => {
  it('each principal sees only the tools its scopes grant', async () => {
    const { conn, plans } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    expect(await toolNames(erp.client)).toEqual([
      'find_customer',
      'get_customer_pricing',
      'get_inventory',
      'get_order',
      'get_plan',
      'list_orders',
      'propose_order_change',
      'sales_history',
      'search_products',
    ])
    const ro = await connect('agent-readonly@tenant-a', conn, plans)
    expect(await toolNames(ro.client)).toEqual(['get_order', 'list_orders', 'search_products'])
    const applier = await connect('svc-applier@tenant-a', conn, plans)
    expect(await toolNames(applier.client)).toEqual(['apply_plan', 'get_order', 'list_orders'])
  })

  it('no agent principal is ever offered apply_plan', async () => {
    const { conn, plans } = world()
    for (const id of ['agent-erp@tenant-a', 'agent-readonly@tenant-a', 'agent-intake@tenant-a', 'agent-erp@tenant-b']) {
      const { client } = await connect(id, conn, plans)
      expect(await toolNames(client)).not.toContain('apply_plan')
    }
  })

  it('calling an unlisted tool fails and writes nothing', async () => {
    const { conn, plans, a } = world()
    const ro = await connect('agent-readonly@tenant-a', conn, plans)
    const r = await ro.call('propose_order_change', { order_id: a.keys['order:so-3'], internal_notes: 'x', rationale: 'test' })
    expect(r.isError).toBe(true)
    const r2 = await ro.call('apply_plan', { plan_id: 'plan_x' })
    expect(r2.isError).toBe(true)
    expect(a.writes).toEqual([])
  })
})

describe('tenant scoping', () => {
  it("another tenant's order id is 'not found' and leaks nothing", async () => {
    const { conn, plans, b } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const r = await erp.call('get_order', { order_id: b.keys['order:so-1'] })
    expect(r.isError).toBe(true)
    expect(r.text).toBe('Not found in this account.')
    const p = await erp.call('propose_order_change', { order_id: b.keys['order:so-1'], internal_notes: 'x', rationale: 'test' })
    expect(p.isError).toBe(true)
    expect(p.text).not.toMatch(/Osprey|SO-2001/)
  })

  it("a plan proposed in tenant B cannot be read or applied from tenant A", async () => {
    const { conn, plans, b } = world()
    const erpB = await connect('agent-erp@tenant-b', conn, plans)
    const prop = await erpB.call('propose_order_change', { order_id: b.keys['order:so-1'], internal_notes: 'b note', rationale: 'test' })
    expect(prop.isError).toBe(false)
    const planId = prop.data['plan_id'] as string
    const erpA = await connect('agent-erp@tenant-a', conn, plans)
    expect((await erpA.call('get_plan', { plan_id: planId })).text).toBe('Plan not found.')
    const applierA = await connect('svc-applier@tenant-a', conn, plans)
    expect((await applierA.call('apply_plan', { plan_id: planId })).text).toBe('Plan not found.')
  })
})

describe('reads', () => {
  it('search, inventory, customer licence, pricing floor', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const s = await erp.call('search_products', { query: 'blue dream' })
    expect((s.data['products'] as { sku: string }[]).map((p) => p.sku).sort()).toEqual(['BD-FL-35', 'BD-PR-1'])
    const inv = await erp.call('get_inventory', { product_ids: [a.keys['product:gdp-gummies']] })
    expect(inv.data['rows']).toEqual([{ product_id: a.keys['product:gdp-gummies'], active: 40, reserved: 30, available: 10 }])
    const tam = await erp.call('find_customer', { name: 'Tamarack' })
    expect((tam.data['customers'] as { can_receive_orders: boolean }[])[0]!.can_receive_orders).toBe(false)
    const price = await erp.call('get_customer_pricing', { company_id: a.keys['company:harborview'], product_ids: [a.keys['product:bd-flower'], a.keys['product:sd-vape']] })
    const floors = Object.fromEntries((price.data['prices'] as { sku: string; floor_price: number }[]).map((p) => [p.sku, p.floor_price]))
    expect(floors).toEqual({ 'BD-FL-35': 23, 'SD-VC-05': 22 })
  })
})

describe('two-phase writes', () => {
  it('propose writes nothing to Distru and returns a semantic diff', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const r = await erp.call('propose_order_change', {
      company_id: a.keys['company:cinder'],
      items: [{ product_id: a.keys['product:bd-preroll'], quantity: 50, price: 8 }],
      rationale: 'email from Cinder Lane',
    })
    expect(r.isError).toBe(false)
    expect(r.data['destructive']).toBe(false)
    expect((r.data['diff'] as { kind: string }).kind).toBe('create')
    expect(a.writes).toEqual([])
  })

  it('an edit that omits existing lines is destructive and names every deleted row', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    // "Change the Blue Dream to 25": the naive edit sends only that line.
    const r = await erp.call('propose_order_change', {
      order_id: a.keys['order:so-3'],
      items: [{ line_id: a.keys['item:so-3:0'], quantity: 25 }],
      rationale: 'customer asked to change Blue Dream quantity',
    })
    expect(r.data['destructive']).toBe(true)
    const diff = r.data['diff'] as { lines: { deleted: { line_id: string; sku: string }[]; changed: { sku: string }[] }; summary: string }
    expect(diff.lines.deleted.map((l) => [l.line_id, l.sku])).toEqual([[a.keys['item:so-3:1'], 'SD-VC-05']])
    expect(diff.lines.changed.map((l) => l.sku)).toEqual(['BD-FL-35'])
    expect(diff.summary).toContain('- DELETE  SD-VC-05')
    expect((r.data['destructive_reasons'] as string[])[0]).toContain('SD-VC-05')
    expect(a.writes).toEqual([])
  })

  it('keeping every line by id is not destructive', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const r = await erp.call('propose_order_change', {
      order_id: a.keys['order:so-3'],
      items: [{ line_id: a.keys['item:so-3:0'], quantity: 25 }, { line_id: a.keys['item:so-3:1'] }],
      rationale: 'customer asked to change Blue Dream quantity',
    })
    expect(r.data['destructive']).toBe(false)
  })

  it('a hallucinated line id is refused at proposal time', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const r = await erp.call('propose_order_change', { order_id: a.keys['order:so-3'], items: [{ line_id: 'line-that-does-not-exist', quantity: 1 }], rationale: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('is not on this order')
  })

  it('apply needs a recorded approval; destructive approval needs acknowledgement; then it applies exactly once', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const applier = await connect('svc-applier@tenant-a', conn, plans)
    const prop = await erp.call('propose_order_change', { order_id: a.keys['order:so-3'], items: [{ line_id: a.keys['item:so-3:0'], quantity: 25 }], rationale: 'x' })
    const planId = prop.data['plan_id'] as string
    const hash = prop.data['plan_hash'] as string

    const early = await applier.call('apply_plan', { plan_id: planId })
    expect(early.isError).toBe(true)
    expect(early.text).toContain('no recorded human approval')

    await expect(plans.recordDecision(TENANT_A, { planId, planHash: hash, decision: 'APPROVED', approverId: 'human-approver@tenant-a', acknowledgeDestructive: false })).rejects.toThrow(DecisionError)
    await expect(plans.recordDecision(TENANT_A, { planId, planHash: 'f'.repeat(64), decision: 'APPROVED', approverId: 'human-approver@tenant-a', acknowledgeDestructive: true })).rejects.toThrow(/hash/)
    await plans.recordDecision(TENANT_A, { planId, planHash: hash, decision: 'APPROVED', approverId: 'human-approver@tenant-a', acknowledgeDestructive: true })

    const first = await applier.call('apply_plan', { plan_id: planId })
    expect(first.isError).toBe(false)
    expect(first.data['status']).toBe('APPLIED')
    expect(first.data['replayed']).toBe(false)
    const second = await applier.call('apply_plan', { plan_id: planId })
    expect(second.data['replayed']).toBe(true)
    expect(a.writes.length).toBe(1)
    expect(a.orders.find((o) => o.id === a.keys['order:so-3'])!.items.length).toBe(1)
  })

  it('a rejected plan can never be applied', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const applier = await connect('svc-applier@tenant-a', conn, plans)
    const prop = await erp.call('propose_order_change', { order_id: a.keys['order:so-5'], internal_notes: 'n', rationale: 'x' })
    await plans.recordDecision(TENANT_A, { planId: prop.data['plan_id'] as string, planHash: prop.data['plan_hash'] as string, decision: 'REJECTED', approverId: 'human-approver@tenant-a', acknowledgeDestructive: false })
    expect((await applier.call('apply_plan', { plan_id: prop.data['plan_id'] })).isError).toBe(true)
    expect(a.writes).toEqual([])
  })

  it('concurrent applies of one plan write once', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const applier = await connect('svc-applier@tenant-a', conn, plans)
    const prop = await erp.call('propose_order_change', { company_id: a.keys['company:cinder'], items: [{ product_id: a.keys['product:bd-preroll'], quantity: 5, price: 8 }], rationale: 'x' })
    await plans.recordDecision(TENANT_A, { planId: prop.data['plan_id'] as string, planHash: prop.data['plan_hash'] as string, decision: 'APPROVED', approverId: 'human-approver@tenant-a', acknowledgeDestructive: false })
    const results = await Promise.all([1, 2, 3, 4].map(() => applier.call('apply_plan', { plan_id: prop.data['plan_id'] })))
    expect(a.writes.length).toBe(1)
    expect(results.filter((r) => !r.isError && r.data['replayed'] === false).length).toBe(1)
  })

  it('a plan is stale if the order changed after it was computed', async () => {
    const { conn, plans, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans)
    const applier = await connect('svc-applier@tenant-a', conn, plans)
    const prop = await erp.call('propose_order_change', { order_id: a.keys['order:so-5'], internal_notes: 'from plan', rationale: 'x' })
    await plans.recordDecision(TENANT_A, { planId: prop.data['plan_id'] as string, planHash: prop.data['plan_hash'] as string, decision: 'APPROVED', approverId: 'human-approver@tenant-a', acknowledgeDestructive: false })
    // Someone edits the order directly in Distru meanwhile (one minute later).
    const order = a.orders.find((o) => o.id === a.keys['order:so-5'])!
    order.updated = new Date(NOW + 60_000).toISOString()
    const r = await applier.call('apply_plan', { plan_id: prop.data['plan_id'] })
    expect(r.data['status']).toBe('FAILED')
    expect(String(r.data['error'])).toContain('Stale plan')
    expect(a.writes).toEqual([])
  })

  it('every tool call is reported for the audit trail with latency', async () => {
    const { conn, plans, events, a } = world()
    const erp = await connect('agent-erp@tenant-a', conn, plans, events)
    await erp.call('get_order', { order_id: a.keys['order:so-3'] })
    await erp.call('get_order', { order_id: 'nope' })
    expect(events.map((e) => [e.tool, e.ok, e.principalId, e.tenantId])).toEqual([
      ['get_order', true, 'agent-erp@tenant-a', 'tenant-a'],
      ['get_order', false, 'agent-erp@tenant-a', 'tenant-a'],
    ])
    expect(events.every((e) => e.latencyMs >= 0)).toBe(true)
  })
})
