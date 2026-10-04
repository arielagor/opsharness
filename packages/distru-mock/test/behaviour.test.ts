import { describe, expect, it } from 'vitest'
import { DistruApiError, DistruClient } from '@opsharness/distru-client'
import { createMockDistru, MOCK_TOKENS, serveMockDistru, TENANT_A, TENANT_B } from '../src/index.js'

/** Behaviour of the documented contract, exercised through the real typed client. */

const ORIGIN = 'https://mock.distru.invalid'

function setup(opts: { pageSize?: number; token?: string } = {}) {
  let now = Date.parse('2026-10-01T12:00:00.000Z')
  const sleeps: number[] = []
  const mock = createMockDistru({ now: () => now, pageSize: opts.pageSize ?? 3, validateResponses: true })
  const client = new DistruClient({
    baseUrl: ORIGIN,
    token: opts.token ?? MOCK_TOKENS.tenantAFull,
    fetch: mock.fetch,
    // The fake sleep advances the mock clock, so Retry-After is honoured without real waiting.
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  })
  const a = mock.tenants.get(TENANT_A)!
  const b = mock.tenants.get(TENANT_B)!
  return { mock, client, a, b, sleeps, advance: (ms: number) => (now += ms) }
}

async function apiError(p: Promise<unknown>): Promise<DistruApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof DistruApiError) return e
    throw e
  }
  throw new Error('expected a DistruApiError')
}

describe('pagination', () => {
  it('follows next_page until null and returns every row exactly once', async () => {
    const { client, mock, a } = setup({ pageSize: 4 })
    const products = await client.listProducts().all()
    expect(products.map((p) => p.id).sort()).toEqual(a.products.map((p) => p.id).sort())
    const productPages = mock.requests.filter((r) => r.path.endsWith('/products'))
    expect(productPages.length).toBe(Math.ceil(a.products.length / 4))
  })

  it('carries the original filters inside the cursor', async () => {
    const { client, a } = setup({ pageSize: 1 })
    const pending = await client.listOrders({ statuses: ['PENDING'] }).all()
    expect(pending.map((o) => o.status)).toEqual(['PENDING', 'PENDING'])
    expect(pending.length).toBe(a.orders.filter((o) => o.status === 'PENDING').length)
  })

  it('rejects a cursor replayed against another endpoint, or with extra filters', async () => {
    const { mock } = setup({ pageSize: 2 })
    const first = (await (await mock.fetch(`${ORIGIN}/public/v1/products`, { headers: { authorization: `Bearer ${MOCK_TOKENS.tenantAFull}` } })).json()) as { next_page: string }
    const cursor = new URL(first.next_page).searchParams.get('page[after]')!
    const other = await mock.fetch(`${ORIGIN}/public/v1/companies?page[after]=${cursor}`, { headers: { authorization: `Bearer ${MOCK_TOKENS.tenantAFull}` } })
    expect(other.status).toBe(400)
    const extra = await mock.fetch(`${first.next_page}&is_active=true`, { headers: { authorization: `Bearer ${MOCK_TOKENS.tenantAFull}` } })
    expect(extra.status).toBe(400)
  })

  it('rejects a cursor issued to another tenant', async () => {
    const { mock } = setup({ pageSize: 1 })
    const first = (await (await mock.fetch(`${ORIGIN}/public/v1/products`, { headers: { authorization: `Bearer ${MOCK_TOKENS.tenantAFull}` } })).json()) as { next_page: string }
    const res = await mock.fetch(first.next_page, { headers: { authorization: `Bearer ${MOCK_TOKENS.tenantBFull}` } })
    expect(res.status).toBe(400)
  })

  it('the sales-order-item-history report is a single unpaginated response with meta.columns', async () => {
    const { client } = setup()
    const report = await client.salesOrderItemHistory()
    expect(report.data.length).toBeGreaterThan(0)
    expect(report.meta.columns.map((c) => c.key)).toContain('order_number')
  })
})

describe('filters', () => {
  it('bracketed array filters, and a bare array key is a 400', async () => {
    const { client, mock, a } = setup()
    const one = await client.listProducts({ ids: [a.keys['product:sd-vape']!] }).all()
    expect(one.map((p) => p.sku)).toEqual(['SD-VC-05'])
    const res = await mock.fetch(`${ORIGIN}/public/v1/products?ids=${a.keys['product:sd-vape']}`, { headers: { authorization: `Bearer ${MOCK_TOKENS.tenantAFull}` } })
    expect(res.status).toBe(400)
  })

  it('inclusive datetime ranges with an open side', async () => {
    const { client, a } = setup()
    const so3 = a.orders.find((o) => o.id === a.keys['order:so-3'])!
    const from = await client.listOrders({ order_datetime: `${so3.orderDatetime},` }).all()
    expect(from.map((o) => o.id)).toContain(so3.id)
    const until = await client.listOrders({ order_datetime: `,${so3.orderDatetime}` }).all()
    expect(until.map((o) => o.id)).toContain(so3.id)
  })

  it('inventory: available = active - reserved, zero groups omitted', async () => {
    const { client, a } = setup({ pageSize: 50 })
    const rows = await client.listInventory({ groupings: ['PRODUCT'] }).all()
    const gummies = rows.find((r) => r.product_id === a.keys['product:gdp-gummies'])!
    expect([gummies.active, gummies.reserved, gummies.available].map(Number)).toEqual([40, 30, 10])
    expect(rows.find((r) => r.product_id === a.keys['product:pe-flower'])).toBeUndefined()
    const flower = rows.find((r) => r.product_id === a.keys['product:bd-flower'])!
    expect(Number(flower.active)).toBe(170)
  })
})

describe('upsert semantics', () => {
  it('a sparse update changes only the sent fields', async () => {
    const { client, a } = setup()
    const before = await client.getOrder(a.keys['order:so-3']!)
    const after = await client.upsertOrder({ id: before.id, internal_notes: 'synthetic: call before delivery' })
    expect(after.internal_notes).toBe('synthetic: call before delivery')
    expect(after.items!.map((i) => i.id)).toEqual(before.items!.map((i) => i.id))
    expect(after.status).toBe(before.status)
  })

  it('sending items REPLACES the set: an omitted existing line is deleted', async () => {
    const { client, a } = setup()
    const id = a.keys['order:so-3']!
    const keep = a.keys['item:so-3:0']!
    const after = await client.upsertOrder({ id, items: [{ id: keep, quantity: 25 } as never] })
    expect(after.items!.map((i) => i.id)).toEqual([keep])
    expect(Number(after.items![0]!.quantity)).toBe(25)
  })

  it('{id} alone keeps a line unchanged; a new entry is added', async () => {
    const { client, a } = setup()
    const id = a.keys['order:so-3']!
    const after = await client.upsertOrder({
      id,
      items: [{ id: a.keys['item:so-3:0']! } as never, { id: a.keys['item:so-3:1']! } as never, { product_id: a.keys['product:bd-preroll']!, quantity: 5, price_base: 8 }],
    })
    expect(after.items!.length).toBe(3)
    expect(Number(after.items![0]!.quantity)).toBe(20)
  })

  it('items: [] is a 400 and nothing changes', async () => {
    const { client, a } = setup()
    const id = a.keys['order:so-3']!
    const before = await client.getOrder(id)
    const err = await apiError(client.upsertOrder({ id, items: [] }))
    expect(err.status).toBe(400)
    expect(err.errors[0]!.pointer).toEqual(['items'])
    expect((await client.getOrder(id)).items!.length).toBe(before.items!.length)
  })

  it('null on a required field is a 400; null on an optional field clears it', async () => {
    const { client, a } = setup()
    const id = a.keys['order:so-3']!
    expect((await apiError(client.upsertOrder({ id, status: null } as never))).status).toBe(400)
    await client.upsertOrder({ id, internal_notes: 'x' })
    const cleared = await client.upsertOrder({ id, internal_notes: null } as never)
    expect(cleared.internal_notes ?? null).toBeNull()
  })

  it('a customer, once set, cannot be cleared', async () => {
    const { client, a } = setup()
    const err = await apiError(client.upsertOrder({ id: a.keys['order:so-3']!, company_id: null } as never))
    expect(err.status).toBe(400)
    expect(err.errors[0]!.pointer).toEqual(['company_id'])
  })

  it('a validation failure in one line rolls back the whole upsert', async () => {
    const { client, a } = setup()
    const id = a.keys['order:so-3']!
    const err = await apiError(
      client.upsertOrder({ id, internal_notes: 'should not stick', items: [{ id: a.keys['item:so-3:0']! } as never, { product_id: a.keys['product:bd-preroll']!, quantity: -1, price_base: 8 }] }),
    )
    expect(err.status).toBe(400)
    expect(err.errors[0]!.pointer).toEqual(['items', 1, 'quantity'])
    const after = await client.getOrder(id)
    expect(after.items!.length).toBe(2)
    expect(after.internal_notes ?? null).toBeNull()
  })

  it('AUTO price-tier mode locks the buyer tier price', async () => {
    const { client, a } = setup()
    const order = await client.upsertOrder({
      company_id: a.keys['company:pelican']!,
      status: 'PENDING',
      order_datetime: '2026-10-01T10:00:00Z',
      items: [{ product_id: a.keys['product:hq-tincture']!, quantity: 2, price_base: 35, price_tier_mode: 'AUTO' }],
    })
    expect(order.items![0]!.price).toBe('31.50')
  })

  it('READY_TO_SHIP requires a customer', async () => {
    const { client, a } = setup()
    const err = await apiError(
      client.upsertOrder({ status: 'READY_TO_SHIP', order_datetime: '2026-10-01T10:00:00Z', items: [{ product_id: a.keys['product:bd-preroll']!, quantity: 1, price_base: 8 }] }),
    )
    expect(err.status).toBe(400)
  })

  it('writes are logged; read-only tokens get 403 and change nothing', async () => {
    const ro = setup({ token: MOCK_TOKENS.tenantAReadOnly })
    const err = await apiError(ro.client.upsertOrder({ id: ro.a.keys['order:so-3']!, internal_notes: 'x' }))
    expect(err.status).toBe(403)
    expect(ro.a.writes).toEqual([])
    const rw = setup()
    await rw.client.upsertOrder({ id: rw.a.keys['order:so-3']!, internal_notes: 'x' })
    expect(rw.a.writes.length).toBe(1)
  })
})

describe('tenancy', () => {
  it("another tenant's id is a plain 404 with no data leaked, on reads and writes", async () => {
    const { client, b } = setup()
    const foreignOrder = b.keys['order:so-1']!
    const read = await apiError(client.getOrder(foreignOrder))
    expect(read.status).toBe(404)
    expect(JSON.stringify(read.errors)).not.toContain('Osprey')
    const write = await apiError(client.upsertOrder({ id: foreignOrder, internal_notes: 'pwned' }))
    expect(write.status).toBe(404)
    expect(b.orders[0]!.internalNotes).toBeUndefined()
    expect((await apiError(client.getProduct(b.keys['product:bd-flower']!))).status).toBe(404)
    expect((await apiError(client.getCompany(b.keys['company:osprey']!))).status).toBe(404)
  })

  it("a list filtered by another tenant's ids returns nothing", async () => {
    const { client, b } = setup()
    expect(await client.listOrders({ ids: [b.keys['order:so-1']!] }).all()).toEqual([])
  })

  it('a missing or unknown token is 401', async () => {
    const { mock } = setup()
    expect((await mock.fetch(`${ORIGIN}/public/v1/products`)).status).toBe(401)
  })
})

describe('rate limits', () => {
  it('PDF: the 21st download in a minute is a 429 with Retry-After; the client waits exactly that long and succeeds', async () => {
    const { client, a, sleeps, mock } = setup()
    const id = a.keys['order:so-1']!
    for (let i = 0; i < 20; i++) await client.orderPdfUrl(id)
    const pdf = await client.orderPdfUrl(id)
    expect(pdf.url).toContain('.pdf')
    expect(sleeps.length).toBe(1)
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000)
    expect(sleeps[0]).toBeLessThanOrEqual(60_000)
    expect(mock.requests.filter((r) => r.status === 429).length).toBe(1)
  })

  it('only PDF endpoints are rate limited', async () => {
    const { client } = setup()
    for (let i = 0; i < 40; i++) await client.getProduct((await client.listProducts().all())[0]!.id)
  })
})

describe('over HTTP', () => {
  it('serves the same contract on a real socket', async () => {
    const server = await serveMockDistru(0, { validateResponses: true })
    try {
      const client = new DistruClient({ baseUrl: new URL(server.url).origin, token: MOCK_TOKENS.tenantAFull })
      const companies = await client.listCompanies().all()
      expect(companies.length).toBe(6)
      expect(companies.every((c) => c.name.includes('[SYNTHETIC]'))).toBe(true)
    } finally {
      await server.close()
    }
  })
})
