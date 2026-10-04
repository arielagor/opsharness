import { describe, expect, it } from 'vitest'
import { SUBSET } from '@opsharness/distru-contract'
import { createMockDistru, MOCK_TOKENS, TENANT_A, validateResponse } from '../src/index.js'

/**
 * Contract test: every response the mock produces for the subset, success AND error, must
 * validate against Distru's published OpenAPI schema for that operation and status.
 */

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const ORIGIN = 'https://mock.distru.invalid'

function harness() {
  const mock = createMockDistru({ now: () => NOW, pageSize: 3 })
  const a = mock.tenants.get(TENANT_A)!
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, token: string = MOCK_TOKENS.tenantAFull) => {
    const res = await mock.fetch(`${ORIGIN}/public/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const isPdf = res.headers.get('content-type') === 'application/pdf'
    return { status: res.status, body: isPdf ? await res.text() : ((await res.json()) as unknown), headers: res.headers }
  }
  return { mock, a, call }
}

function specPathFor(path: string): string {
  return `/public/v1${path.split('?')[0]!}`
    .replace(/\/products\/[^/]+$/, '/products/{id}')
    .replace(/\/companies\/[^/]+$/, '/companies/{id}')
    .replace(/\/orders\/[^/]+\/pdf$/, '/orders/{id}/pdf')
    .replace(/\/orders\/(?!\{)[^/]+$/, '/orders/{id}')
}

describe('every mock response validates against the published schema', () => {
  const { a, call } = harness()
  const cases: [string, 'GET' | 'POST', string, unknown?][] = [
    ['products list', 'GET', '/products'],
    ['products filtered', 'GET', `/products?ids[]=${a.keys['product:bd-flower']}&is_active=true`],
    ['product by id', 'GET', `/products/${a.keys['product:sd-vape']}`],
    ['inventory by product', 'GET', '/inventory?groupings[]=PRODUCT'],
    ['inventory by product and location', 'GET', '/inventory?groupings[]=PRODUCT&groupings[]=LOCATION'],
    ['companies list', 'GET', '/companies'],
    ['company by id', 'GET', `/companies/${a.keys['company:tamarack']}`],
    ['orders list', 'GET', '/orders'],
    ['orders by status', 'GET', '/orders?statuses[]=PENDING&order_datetime=2026-09-01T00:00:00Z,'],
    ['order by id', 'GET', `/orders/${a.keys['order:so-3']}`],
    ['invoices', 'GET', '/invoices'],
    ['price tiers', 'GET', '/price-tiers'],
    ['sales order item history', 'GET', '/reports/sales-order-item-history'],
    ['order pdf url', 'POST', `/orders/${a.keys['order:so-1']}/pdf`, { format: 'url' }],
    [
      'create order',
      'POST',
      '/orders',
      { company_id: a.keys['company:cinder'], status: 'PENDING', order_datetime: '2026-10-01T10:00:00Z', items: [{ product_id: a.keys['product:bd-preroll'], quantity: 10, price_base: 8, price_tier_mode: 'AUTO' }] },
    ],
    ['update order notes', 'POST', '/orders', { id: a.keys['order:so-5'], internal_notes: 'synthetic note' }],
    // Errors: every one must use the documented envelope and a documented status.
    ['404 unknown product', 'GET', '/products/00000000-0000-4000-a000-000000000000'],
    ['404 unknown order', 'GET', '/orders/00000000-0000-4000-a000-000000000000'],
    ['400 bare array key', 'GET', '/orders?statuses=PENDING'],
    ['400 bad range', 'GET', '/orders?order_datetime=yesterday'],
    ['400 inventory without groupings', 'GET', '/inventory'],
    ['400 empty items', 'POST', '/orders', { id: a.keys['order:so-3'], items: [] }],
    ['400 null required field', 'POST', '/orders', { id: a.keys['order:so-3'], status: null }],
    ['404 update unknown order', 'POST', '/orders', { id: '00000000-0000-4000-a000-000000000000', internal_notes: 'x' }],
  ]

  it.each(cases)('%s', async (_name, method, path, body) => {
    const res = await call(method, path, body)
    const violations = validateResponse(method.toLowerCase(), specPathFor(path), res.status, res.body)
    expect(violations, JSON.stringify(res.body).slice(0, 400)).toEqual([])
    expect([200, 201, 400, 401, 403, 404, 429]).toContain(res.status)
  })

  it('covers every operation in the subset', () => {
    const covered = new Set(cases.map(([, m, p]) => `${m.toLowerCase()} ${specPathFor(p)}`))
    const missing = SUBSET.filter(([m, p]) => !covered.has(`${m} ${p}`))
    expect(missing).toEqual([])
  })

  it('validates 401, 403 and 429 responses too', async () => {
    const h = harness()
    const r401 = await h.call('GET', '/products', undefined, 'not-a-token')
    expect(r401.status).toBe(401)
    expect(validateResponse('get', '/public/v1/products', 401, r401.body)).toEqual([])
    const r403 = await h.call('POST', '/orders', { id: h.a.keys['order:so-3'], internal_notes: 'x' }, MOCK_TOKENS.tenantAReadOnly)
    expect(r403.status).toBe(403)
    expect(validateResponse('post', '/public/v1/orders', 403, r403.body)).toEqual([])
    let last = { status: 200, body: {} as unknown }
    for (let i = 0; i < 21; i++) last = await h.call('POST', `/orders/${h.a.keys['order:so-1']}/pdf`, { format: 'url' })
    expect(last.status).toBe(429)
    expect(validateResponse('post', '/public/v1/orders/{id}/pdf', 429, last.body)).toEqual([])
  })

  it('a mock that drifts from the spec fails loudly under validateResponses', async () => {
    const mock = createMockDistru({ now: () => NOW, validateResponses: true })
    const t = mock.tenants.get(TENANT_A)!
    // Corrupt one record so the presenter emits an invalid status enum value.
    ;(t.orders[0] as { status: string }).status = 'SHIPPED_BY_DRONE'
    const res = await mock.fetch(`${ORIGIN}/public/v1/orders/${t.orders[0]!.id}`, { headers: { authorization: `Bearer ${MOCK_TOKENS.tenantAFull}` } })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).toContain('MOCK CONTRACT VIOLATION')
  })
})
