import { describe, expect, it } from 'vitest'
import {
  DistruApiError,
  DistruClientError,
  buildQuery,
  chunkIds,
  createDistruClient,
  datetimeRange,
  parseErrorEnvelope,
  parseRetryAfter,
  pointerToString,
} from '../src/index.js'

type Handler = (req: { method: string; url: string; headers: Record<string, string>; body?: unknown }) => {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function fakeFetch(handler: Handler) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    }
    calls.push(req)
    const res = handler(req)
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json', ...(res.headers ?? {}) },
    })
  }) as typeof fetch
  return { impl, calls }
}

const BASE = 'https://distru.example'

describe('buildQuery', () => {
  it('repeats bracketed keys for arrays and never emits a bare array key', () => {
    expect(buildQuery({ ids: ['a', 'b'], name: 'Blue Dream' })).toBe('ids[]=a&ids[]=b&name=Blue%20Dream')
  })

  it('rejects more than 200 values before any request is sent', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id-${i}`)
    expect(() => buildQuery({ ids })).toThrow(DistruClientError)
    expect(() => buildQuery({ ids: ids.slice(0, 200) })).not.toThrow()
  })

  it('refuses a page selector', () => {
    expect(() => buildQuery({ page: 'x' })).toThrow(/next_page/)
  })

  it('encodes custom_data as custom_data[<id>]=value and skips null/undefined', () => {
    expect(buildQuery({ custom_data: { '12': 'yes' }, skip: undefined, also: null, active: true })).toBe(
      'custom_data[12]=yes&active=true',
    )
  })

  it('chunks long id lists at 200', () => {
    expect(chunkIds(Array.from({ length: 450 }, (_, i) => i)).map((c) => c.length)).toEqual([200, 200, 50])
  })
})

describe('datetimeRange', () => {
  it('builds inclusive comma ranges with optional open sides', () => {
    expect(datetimeRange({ from: '2025-05-04T00:00:00.000000Z' })).toBe('2025-05-04T00:00:00.000000Z,')
    expect(datetimeRange({ to: new Date('2025-05-05T00:00:00Z') })).toBe(',2025-05-05T00:00:00.000Z')
    expect(datetimeRange({ from: 'a', to: 'b' })).toBe('a,b')
    expect(() => datetimeRange({})).toThrow(DistruClientError)
  })
})

describe('error envelope', () => {
  it('parses message and pointer and drops deprecated fields', () => {
    const errors = parseErrorEnvelope({
      errors: [{ message: 'Quantity must be greater than 0', pointer: ['items', 0, 'quantity'], section: 'x', context: {} }],
    })
    expect(errors).toEqual([{ message: 'Quantity must be greater than 0', pointer: ['items', 0, 'quantity'] }])
    expect(pointerToString(errors[0]!.pointer)).toBe('items[0].quantity')
    expect(pointerToString(['base'])).toBe('(request)')
  })

  it('turns a non-envelope body into one base error', () => {
    expect(parseErrorEnvelope('<html>')).toEqual([{ message: 'Response body was not a Distru error envelope', pointer: ['base'] }])
    expect(parseErrorEnvelope({ errors: [] })[0]!.pointer).toEqual(['base'])
  })
})

describe('pagination', () => {
  it('follows next_page verbatim until null and never builds a selector', async () => {
    const { impl, calls } = fakeFetch((req) => {
      if (req.url === `${BASE}/public/v1/products?name=dream`)
        return { status: 200, body: { data: [{ id: '1' }], next_page: `${BASE}/public/v1/products?page[after]=opaque-AAA` } }
      if (req.url === `${BASE}/public/v1/products?page[after]=opaque-AAA`)
        return { status: 200, body: { data: [{ id: '2' }, { id: '3' }], next_page: `${BASE}/public/v1/products?page[after]=opaque-BBB` } }
      if (req.url === `${BASE}/public/v1/products?page[after]=opaque-BBB`) return { status: 200, body: { data: [], next_page: null } }
      return { status: 500 }
    })
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl })
    const rows = await client.listProducts({ name: 'dream' }).all()
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(calls).toHaveLength(3)
    expect(calls[0]!.headers['Authorization']).toBe('Bearer t')
  })

  it('refuses to send the token to a next_page on another origin', async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { data: [], next_page: 'https://evil.example/public/v1/products?page[after]=x' } }))
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl })
    await expect(client.listProducts().all()).rejects.toThrow(/different origin/)
  })
})

describe('status handling', () => {
  it('waits exactly Retry-After seconds on 429, then retries', async () => {
    let n = 0
    const { impl } = fakeFetch(() =>
      ++n === 1
        ? { status: 429, headers: { 'retry-after': '42' }, body: { errors: [{ message: 'PDF download rate limit exceeded', pointer: ['base'] }] } }
        : { status: 200, body: { data: { url: 'https://files.example/x.pdf', expires_datetime: '2026-10-05T00:00:00Z' } } },
    )
    const slept: number[] = []
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl, sleep: async (ms) => void slept.push(ms) })
    const pdf = await client.orderPdfUrl('order-1')
    expect(pdf.url).toBe('https://files.example/x.pdf')
    expect(slept).toEqual([42_000])
  })

  it('gives up after maxRateLimitRetries and surfaces Retry-After', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '5' }, body: { errors: [{ message: 'limited', pointer: ['base'] }] } }))
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl, sleep: async () => {}, maxRateLimitRetries: 2 })
    const err = await client.orderPdfUrl('o').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DistruApiError)
    expect((err as DistruApiError).retryAfterSeconds).toBe(5)
    expect(calls).toHaveLength(3)
  })

  it('does not invent a schedule when a 429 has no Retry-After', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 429, body: { errors: [{ message: 'limited', pointer: ['base'] }] } }))
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl, sleep: async () => {} })
    await expect(client.orderPdfUrl('o')).rejects.toBeInstanceOf(DistruApiError)
    expect(calls).toHaveLength(1)
  })

  it.each([400, 401, 403, 404, 500])('never retries a %i', async (status) => {
    const { impl, calls } = fakeFetch(() => ({ status, body: { errors: [{ message: 'nope', pointer: ['id'] }] } }))
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl, sleep: async () => {} })
    const err = (await client.getOrder('x').catch((e: unknown) => e)) as DistruApiError
    expect(err.status).toBe(status)
    expect(err.isRetryable).toBe(false)
    expect(err.isNotFound).toBe(status === 404)
    expect(calls).toHaveLength(1)
  })

  it('treats a 422 as just another error status (the API never sends one)', async () => {
    const { impl } = fakeFetch(() => ({ status: 422, body: { errors: [{ message: 'x', pointer: ['base'] }] } }))
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl })
    const err = (await client.getOrder('x').catch((e: unknown) => e)) as DistruApiError
    expect(err).toBeInstanceOf(DistruApiError)
    expect(err.status).toBe(422)
  })

  it('url-encodes opaque ids and rejects an empty id', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { data: { id: 'a/b' } } }))
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl })
    await client.getOrder('a/b')
    expect(calls[0]!.url).toBe(`${BASE}/public/v1/orders/a%2Fb`)
    await expect(client.getOrder('')).rejects.toBeInstanceOf(DistruClientError)
  })

  it('sends upserts as JSON POSTs to the same URL for create and update', async () => {
    const { impl, calls } = fakeFetch((req) => ({ status: 200, body: { data: { id: (req.body as { id?: string }).id ?? 'new' } } }))
    const client = createDistruClient({ baseUrl: BASE, token: 't', fetch: impl })
    await client.upsertOrder({ status: 'PENDING', order_datetime: '2026-10-01T00:00:00Z', items: [{ product_id: 'p', quantity: 1, price_base: 10 }] })
    await client.upsertOrder({ id: 'o1', internal_notes: 'x' })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${BASE}/public/v1/orders`, `POST ${BASE}/public/v1/orders`])
    expect(calls[0]!.headers['Content-Type']).toBe('application/json')
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP-dates', () => {
    expect(parseRetryAfter('42')).toBe(42)
    expect(parseRetryAfter(new Date(10_000 + 30_000).toUTCString(), 10_000)).toBe(30)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})
