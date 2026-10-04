import { createHash } from 'node:crypto'
import type { Permission, Tenant } from './model.js'
import {
  invoiceStatus,
  presentCompany,
  presentInvoice,
  presentOrder,
  presentPriceTier,
  presentProduct,
  reservedFor,
} from './present.js'
import { BadRequest, inRange, parseQuery, parseRange, type ParsedQuery } from './query.js'
import { seedTenants, type SeededTenant } from './seed.js'
import { NotFound, upsertOrder, type OrderInput } from './upsert.js'
import { validateRequest, validateResponse } from './validate.js'
import { money, qty } from './model.js'

export interface MockDistruOptions {
  /** Server page size. Clients must not assume it; tests set it small to force paging. */
  pageSize?: number
  /** Injected clock (ms since epoch). */
  now?: () => number
  /** Validate every response against the spec and fail loudly (500) on a mismatch. */
  validateResponses?: boolean
  /** PDF limits: per minute and per day, sliding windows. */
  pdfPerMinute?: number
  pdfPerDay?: number
}

export interface MockDistru {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  tenants: Map<string, SeededTenant>
  /** Every request seen, for assertions. */
  requests: { method: string; path: string; status: number; tenant?: string }[]
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly pointer: (string | number)[],
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

const PREFIX = '/public/v1'

interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  spec: string
  permission: Permission | ((t: Tenant, body: unknown) => Permission)
  handle: (ctx: Ctx) => { status: number; body: unknown; headers?: Record<string, string> }
}

interface Ctx {
  tenant: SeededTenant
  url: URL
  params: string[]
  query: ParsedQuery
  body: unknown
  now: number
  origin: string
  pageSize: number
  opts: Required<Pick<MockDistruOptions, 'pdfPerMinute' | 'pdfPerDay'>>
}

// ---------- pagination ---------------------------------------------------------------------

interface Cursor { t: string; p: string; q: string; after: string }

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
    if (typeof c.t === 'string' && typeof c.p === 'string' && typeof c.q === 'string' && typeof c.after === 'string') return c
  } catch {
    // fall through
  }
  throw new BadRequest(['page'], 'Invalid page cursor')
}

function paginate<T extends { id: string }>(ctx: Ctx, rows: T[], present: (r: T) => unknown, originalQuery: string, after?: string) {
  let start = 0
  if (after !== undefined) {
    const i = rows.findIndex((r) => r.id === after)
    start = i === -1 ? rows.length : i + 1
  }
  const page = rows.slice(start, start + ctx.pageSize)
  const more = start + ctx.pageSize < rows.length
  const next_page = more
    ? `${ctx.origin}${ctx.url.pathname}?page[after]=${encodeCursor({ t: ctx.tenant.id, p: ctx.url.pathname, q: originalQuery, after: page[page.length - 1]!.id })}`
    : null
  return { data: page.map(present), next_page }
}

/** Resolves page[after]: the cursor must come from this endpoint and this tenant. */
function effectiveQuery(ctx: Ctx, specPath: string): { query: ParsedQuery; original: string; after?: string } {
  if (ctx.query.pageAfter === undefined) return { query: ctx.query, original: ctx.url.search.replace(/^\?/, '') }
  const c = decodeCursor(ctx.query.pageAfter)
  if (c.t !== ctx.tenant.id || c.p !== ctx.url.pathname) throw new BadRequest(['page'], 'This page cursor was not issued by this endpoint')
  return { query: parseQuery('get', specPath, new URLSearchParams(c.q)), original: c.q, after: c.after }
}

function onlyImplemented(q: ParsedQuery, implemented: string[]) {
  const all = [...q.scalars.keys(), ...q.arrays.keys(), ...q.objects.keys()]
  for (const k of all) {
    if (!implemented.includes(k)) throw new BadRequest([k], `Filter ${k} is declared by Distru's spec but not implemented by this mock`)
  }
}

const ci = (s: string) => s.toLowerCase()

// ---------- routes -------------------------------------------------------------------------

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/products$/,
    spec: '/public/v1/products',
    permission: 'products_permissions_view',
    handle(ctx) {
      const { query: q, original, after } = effectiveQuery(ctx, this.spec)
      onlyImplemented(q, ['ids', 'name', 'sku', 'names', 'skus', 'is_active', 'updated_datetime', 'inserted_datetime'])
      const ids = q.arrays.get('ids')
      const names = q.arrays.get('names')?.map(ci)
      const skus = q.arrays.get('skus')?.map(ci)
      const name = q.scalars.get('name')
      const sku = q.scalars.get('sku')
      const active = q.scalars.get('is_active')
      const updated = parseRange('updated_datetime', q.scalars.get('updated_datetime'))
      const inserted = parseRange('inserted_datetime', q.scalars.get('inserted_datetime'))
      const rows = ctx.tenant.products
        .filter((p) => (!ids?.length || ids.includes(p.id)))
        .filter((p) => (!names || names.includes(ci(p.name))) && (!skus || skus.includes(ci(p.sku))))
        .filter((p) => (!name || ci(p.name).includes(ci(name))) && (!sku || ci(p.sku).includes(ci(sku))))
        .filter((p) => active === undefined || String(p.isActive) === active)
        .filter((p) => inRange(p.updated, updated) && inRange(p.inserted, inserted))
        .sort((a, b) => a.inserted.localeCompare(b.inserted) || a.id.localeCompare(b.id))
      return { status: 200, body: paginate(ctx, rows, (p) => presentProduct(ctx.tenant, p), original, after) }
    },
  },
  {
    method: 'GET',
    pattern: /^\/products\/([^/]+)$/,
    spec: '/public/v1/products/{id}',
    permission: 'products_permissions_view',
    handle(ctx) {
      const p = ctx.tenant.products.find((x) => x.id === ctx.params[0])
      if (!p) throw new HttpError(404, ['id'], 'Not Found')
      return { status: 200, body: { data: presentProduct(ctx.tenant, p) } }
    },
  },
  {
    method: 'GET',
    pattern: /^\/inventory$/,
    spec: '/public/v1/inventory',
    permission: 'products_permissions_view',
    handle(ctx) {
      const { query: q, original, after } = effectiveQuery(ctx, this.spec)
      onlyImplemented(q, ['groupings', 'product_ids', 'location_ids', 'product_skus'])
      const groupings = q.arrays.get('groupings')
      if (!groupings?.length) throw new BadRequest(['groupings'], 'groupings is required')
      const productIds = q.arrays.get('product_ids')
      const locationIds = q.arrays.get('location_ids')
      const skus = q.arrays.get('product_skus')?.map(ci)
      const t = ctx.tenant
      // Every synthetic product is PRODUCT-tracked, so grouping by BATCH_NUMBER excludes all of them.
      if (groupings.includes('BATCH_NUMBER')) return { status: 200, body: { data: [], next_page: null } }
      const byLocation = groupings.includes('LOCATION')
      const groups = new Map<string, { id: string; product_id: string; location_id?: string; active: number; reserved: number }>()
      for (const s of t.stock) {
        const product = t.products.find((p) => p.id === s.productId)!
        if (productIds?.length && !productIds.includes(s.productId)) continue
        if (locationIds?.length && !locationIds.includes(s.locationId)) continue
        if (skus && !skus.includes(ci(product.sku))) continue
        const key = byLocation ? `${s.productId}|${s.locationId}` : s.productId
        const g = groups.get(key) ?? { id: key, product_id: s.productId, ...(byLocation ? { location_id: s.locationId } : {}), active: 0, reserved: 0 }
        g.active += s.active
        groups.set(key, g)
      }
      for (const g of groups.values()) {
        // Reservations attach to the order item's location (the warehouse in this mock).
        g.reserved = !byLocation || g.location_id === t.warehouse.id ? reservedFor(t, g.product_id) : 0
      }
      const rows = [...groups.values()]
        .filter((g) => g.active !== 0 || g.active - g.reserved !== 0)
        .sort((a, b) => a.id.localeCompare(b.id))
      const updated = new Date(ctx.now).toISOString()
      return {
        status: 200,
        body: paginate(
          ctx,
          rows,
          (g) => ({
            product_id: g.product_id,
            ...(g.location_id ? { location_id: g.location_id } : {}),
            active: qty(g.active),
            reserved: qty(g.reserved),
            available: qty(g.active - g.reserved),
            updated_datetime: updated,
          }),
          original,
          after,
        ),
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/companies$/,
    spec: '/public/v1/companies',
    permission: 'companies_permissions_view',
    handle(ctx) {
      const { query: q, original, after } = effectiveQuery(ctx, this.spec)
      onlyImplemented(q, ['ids', 'name', 'names', 'license_number', 'updated_datetime', 'inserted_datetime'])
      const ids = q.arrays.get('ids')
      const names = q.arrays.get('names')?.map(ci)
      const name = q.scalars.get('name')
      const licence = q.scalars.get('license_number')
      const updated = parseRange('updated_datetime', q.scalars.get('updated_datetime'))
      const inserted = parseRange('inserted_datetime', q.scalars.get('inserted_datetime'))
      const rows = ctx.tenant.companies
        .filter((c) => !ids?.length || ids.includes(c.id))
        .filter((c) => (!names || names.includes(ci(c.name))) && (!name || ci(c.name).includes(ci(name)) || ci(c.legalName).includes(ci(name))))
        .filter((c) => !licence || c.licenses.some((l) => ci(l.number) === ci(licence)))
        .filter((c) => inRange(c.updated, updated) && inRange(c.inserted, inserted))
        .sort((a, b) => a.inserted.localeCompare(b.inserted) || a.id.localeCompare(b.id))
      return { status: 200, body: paginate(ctx, rows, presentCompany, original, after) }
    },
  },
  {
    method: 'GET',
    pattern: /^\/companies\/([^/]+)$/,
    spec: '/public/v1/companies/{id}',
    permission: 'companies_permissions_view',
    handle(ctx) {
      const c = ctx.tenant.companies.find((x) => x.id === ctx.params[0])
      if (!c) throw new HttpError(404, ['id'], 'Not Found')
      return { status: 200, body: { data: presentCompany(c) } }
    },
  },
  {
    method: 'GET',
    pattern: /^\/orders$/,
    spec: '/public/v1/orders',
    permission: 'orders_permissions_view',
    handle(ctx) {
      const { query: q, original, after } = effectiveQuery(ctx, this.spec)
      onlyImplemented(q, ['ids', 'statuses', 'company_ids', 'order_number', 'order_numbers', 'order_datetime', 'updated_datetime', 'product_ids'])
      const ids = q.arrays.get('ids')
      const statuses = q.arrays.get('statuses')
      const companies = q.arrays.get('company_ids')
      const numbers = q.arrays.get('order_numbers')
      const number = q.scalars.get('order_number')
      const products = q.arrays.get('product_ids')
      const orderRange = parseRange('order_datetime', q.scalars.get('order_datetime'))
      const updated = parseRange('updated_datetime', q.scalars.get('updated_datetime'))
      const rows = ctx.tenant.orders
        .filter((o) => !ids?.length || ids.includes(o.id))
        .filter((o) => !statuses || statuses.includes(o.status))
        .filter((o) => !companies || (o.companyId !== undefined && companies.includes(o.companyId)))
        .filter((o) => (!numbers || numbers.includes(o.number)) && (!number || o.number === number))
        .filter((o) => !products || o.items.some((i) => products.includes(i.productId)))
        .filter((o) => inRange(o.orderDatetime, orderRange) && inRange(o.updated, updated))
        .sort((a, b) => b.orderDatetime.localeCompare(a.orderDatetime) || a.id.localeCompare(b.id))
      return { status: 200, body: paginate(ctx, rows, (o) => presentOrder(ctx.tenant, o), original, after) }
    },
  },
  {
    method: 'GET',
    pattern: /^\/orders\/([^/]+)$/,
    spec: '/public/v1/orders/{id}',
    permission: 'orders_permissions_view',
    handle(ctx) {
      const o = ctx.tenant.orders.find((x) => x.id === ctx.params[0])
      if (!o) throw new HttpError(404, ['id'], 'Not Found')
      return { status: 200, body: { data: presentOrder(ctx.tenant, o) } }
    },
  },
  {
    method: 'POST',
    pattern: /^\/orders$/,
    spec: '/public/v1/orders',
    permission: (_t, body) => ((body as { id?: unknown } | null)?.id ? 'orders_permissions_edit' : 'orders_permissions_create'),
    handle(ctx) {
      const violations = validateRequest('post', this.spec, ctx.body)
      if (violations.length) throw new HttpError(400, violations[0]!.pointer, `Invalid request: ${violations[0]!.message}`)
      try {
        const order = upsertOrder(ctx.tenant, ctx.body as OrderInput, new Date(ctx.now).toISOString())
        return { status: 200, body: { data: presentOrder(ctx.tenant, order) } }
      } catch (e) {
        if (e instanceof NotFound) throw new HttpError(404, e.pointer, 'Not Found')
        throw e
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/orders\/([^/]+)\/pdf$/,
    spec: '/public/v1/orders/{id}/pdf',
    permission: 'orders_permissions_view',
    handle(ctx) {
      const violations = validateRequest('post', this.spec, ctx.body)
      if (violations.length) throw new HttpError(400, violations[0]!.pointer, `Invalid request: ${violations[0]!.message}`)
      const order = ctx.tenant.orders.find((x) => x.id === ctx.params[0])
      if (!order) throw new HttpError(404, ['id'], 'Not Found')
      const format = (ctx.body as { format: 'binary' | 'url' | 'email' }).format
      const emails = (ctx.body as { email_addresses?: string[] }).email_addresses ?? []
      if (format === 'email' && emails.length === 0) throw new HttpError(400, ['email_addresses'], 'At least one email address is required')
      // Sliding windows; only successful downloads count, so check before recording.
      const t = ctx.tenant
      const minuteAgo = ctx.now - 60_000
      const dayAgo = ctx.now - 86_400_000
      t.pdfDownloads = t.pdfDownloads.filter((ms) => ms > dayAgo)
      const inMinute = t.pdfDownloads.filter((ms) => ms > minuteAgo)
      let retryAfterMs: number | undefined
      if (inMinute.length >= ctx.opts.pdfPerMinute) retryAfterMs = inMinute[inMinute.length - ctx.opts.pdfPerMinute]! + 60_000 - ctx.now
      else if (t.pdfDownloads.length >= ctx.opts.pdfPerDay) retryAfterMs = t.pdfDownloads[t.pdfDownloads.length - ctx.opts.pdfPerDay]! + 86_400_000 - ctx.now
      if (retryAfterMs !== undefined) {
        throw new HttpError(
          429,
          ['base'],
          'PDF download rate limit exceeded (20/minute, 1000/day per account, aggregated across all PDF endpoints). Retry after the Retry-After period.',
          { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
        )
      }
      t.pdfDownloads.push(ctx.now)
      if (format === 'url') {
        return {
          status: 200,
          body: { data: { url: `${ctx.origin}/synthetic-files/${order.number}.pdf?sig=synthetic`, expires_datetime: new Date(ctx.now + 15 * 60_000).toISOString() } },
        }
      }
      if (format === 'email') return { status: 200, body: { data: { emailed_to: emails } } }
      return { status: 200, body: '%PDF-1.4 synthetic order slip', headers: { 'content-type': 'application/pdf' } }
    },
  },
  {
    method: 'GET',
    pattern: /^\/invoices$/,
    spec: '/public/v1/invoices',
    permission: 'invoices_permissions_view',
    handle(ctx) {
      const { query: q, original, after } = effectiveQuery(ctx, this.spec)
      onlyImplemented(q, ['ids', 'order_ids', 'company_ids', 'statuses', 'updated_datetime'])
      const ids = q.arrays.get('ids')
      const orderIds = q.arrays.get('order_ids')
      const companies = q.arrays.get('company_ids')
      const statuses = q.arrays.get('statuses')
      const updated = parseRange('updated_datetime', q.scalars.get('updated_datetime'))
      const t = ctx.tenant
      const rows = t.invoices
        .filter((i) => !ids?.length || ids.includes(i.id))
        .filter((i) => (!orderIds || orderIds.includes(i.orderId)) && (!companies || companies.includes(i.companyId)))
        .filter((i) => !statuses || statuses.includes(invoiceStatus(t, i)))
        .filter((i) => inRange(i.updated, updated))
        .sort((a, b) => a.inserted.localeCompare(b.inserted) || a.id.localeCompare(b.id))
      return { status: 200, body: paginate(ctx, rows, (i) => presentInvoice(t, i), original, after) }
    },
  },
  {
    method: 'GET',
    pattern: /^\/price-tiers$/,
    spec: '/public/v1/price-tiers',
    permission: 'settings_permissions_price_tiers',
    handle(ctx) {
      const { query: q, original, after } = effectiveQuery(ctx, this.spec)
      onlyImplemented(q, ['ids', 'company_relationship_id', 'product_ids'])
      const ids = q.arrays.get('ids')
      const company = q.scalars.get('company_relationship_id')
      const products = q.arrays.get('product_ids')
      const rows = ctx.tenant.priceTiers
        .filter((x) => !ids?.length || ids.includes(x.id))
        .filter((x) => !company || x.oneOfCompanies.length === 0 || x.oneOfCompanies.includes(company))
        .filter((x) => !products || x.oneOfProducts.length === 0 || x.oneOfProducts.some((p) => products.includes(p)))
        .sort((a, b) => a.inserted.localeCompare(b.inserted))
      return { status: 200, body: paginate(ctx, rows, (x) => presentPriceTier(ctx.tenant, x), original, after) }
    },
  },
  {
    method: 'GET',
    pattern: /^\/reports\/sales-order-item-history$/,
    spec: '/public/v1/reports/sales-order-item-history',
    permission: 'reports_permissions_sales_order_item_history',
    handle(ctx) {
      const q = ctx.query
      if (q.pageAfter !== undefined) throw new BadRequest(['page'], 'This report is not paginated')
      onlyImplemented(q, ['order_datetime', 'status', 'company_relationship_ids', 'product_ids'])
      const t = ctx.tenant
      const range = parseRange('order_datetime', q.scalars.get('order_datetime')) ?? { min: ctx.now - 30 * 86_400_000, max: ctx.now }
      const statuses = q.arrays.get('status')
      const companies = q.arrays.get('company_relationship_ids')
      const products = q.arrays.get('product_ids')
      const vendor = t.companies.find((c) => c.category === 'Manufacturer') ?? t.companies[0]!
      const rows = t.orders
        .filter((o) => inRange(o.orderDatetime, range))
        .filter((o) => (!statuses || statuses.includes(o.status)) && (!companies || (o.companyId !== undefined && companies.includes(o.companyId))))
        .sort((a, b) => b.orderDatetime.localeCompare(a.orderDatetime))
        .flatMap((o) => {
          const customer = t.companies.find((c) => c.id === o.companyId)
          return o.items
            .filter((i) => !products || products.includes(i.productId))
            .map((i) => {
              const p = t.products.find((x) => x.id === i.productId)!
              const category = t.categories.find((c) => c.id === p.categoryId)!
              return {
                line_item_id: i.id,
                order_id: o.id,
                order_number: o.number,
                order_date: o.orderDatetime.slice(0, 10),
                order_date_utc: o.orderDatetime.slice(0, 10),
                status: o.status,
                product_id: p.id,
                product: p.name,
                product_sku: p.sku,
                category: category.name,
                vendor_id: vendor.id,
                vendor: vendor.name,
                ...(customer ? { customer: customer.name, customer_id: customer.id } : {}),
                quantity: qty(i.quantity),
                order_item_price: money(i.priceBase),
                default_unit_price: money(p.unitPrice),
              }
            })
        })
      const fmt = (ms: number | undefined) => (ms === undefined ? '' : new Date(ms).toISOString().slice(0, 10))
      return {
        status: 200,
        body: {
          data: rows,
          meta: {
            report: 'Sales Order Item History',
            date_range: `${fmt(range.min)} - ${fmt(range.max)}`,
            columns: [
              { key: 'order_number', label: 'Order #' },
              { key: 'order_date', label: 'Order Date' },
              { key: 'status', label: 'Status' },
              { key: 'customer', label: 'Customer' },
              { key: 'product', label: 'Product' },
              { key: 'product_sku', label: 'SKU' },
              { key: 'quantity', label: 'Quantity' },
              { key: 'order_item_price', label: 'Price' },
            ],
          },
        },
      }
    },
  },
]

// ---------- entry point --------------------------------------------------------------------

function errorBody(pointer: (string | number)[], message: string) {
  return { errors: [{ message, pointer }] }
}

export function createMockDistru(options: MockDistruOptions = {}): MockDistru {
  const tenants = seedTenants()
  const tokenIndex = new Map<string, SeededTenant>()
  for (const t of tenants.values()) for (const token of t.tokens.keys()) tokenIndex.set(token, t)
  const requests: MockDistru['requests'] = []
  const pageSize = options.pageSize ?? 25
  const now = options.now ?? Date.now
  const opts = { pdfPerMinute: options.pdfPerMinute ?? 20, pdfPerDay: options.pdfPerDay ?? 1000 }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const method = req.method.toUpperCase()
    const auth = req.headers.get('authorization') ?? ''
    const token = /^Bearer (.+)$/.exec(auth)?.[1]
    const tenant: SeededTenant | undefined = token ? tokenIndex.get(token) : undefined
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}, specPath?: string) => {
      if (options.validateResponses && specPath && headers['content-type'] !== 'application/pdf') {
        const violations = validateResponse(method.toLowerCase(), specPath, status, body)
        if (violations.length) {
          status = 500
          body = errorBody(['base'], `MOCK CONTRACT VIOLATION: ${JSON.stringify(violations.slice(0, 5))}`)
        }
      }
      requests.push({ method, path: url.pathname, status, ...(tenant ? { tenant: tenant.id } : {}) })
      const isPdf = headers['content-type'] === 'application/pdf'
      return new Response(isPdf ? String(body) : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      })
    }

    if (!url.pathname.startsWith(PREFIX)) return respond(404, errorBody(['base'], 'Not Found'))
    const sub = url.pathname.slice(PREFIX.length)
    if (!tenant) return respond(401, errorBody(['base'], 'Missing or invalid API token'))

    let route: Route | undefined
    let params: string[] = []
    for (const r of routes) {
      const m = r.pattern.exec(sub)
      if (m && r.method === method) {
        route = r
        params = m.slice(1).map(decodeURIComponent)
        break
      }
    }
    if (!route) return respond(404, errorBody(['base'], 'Not Found'))

    let body: unknown
    if (method === 'POST') {
      const text = await req.text()
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        return respond(400, errorBody(['base'], 'Malformed JSON body'), {}, route.spec)
      }
    }

    const permission = typeof route.permission === 'function' ? route.permission(tenant, body) : route.permission
    if (!tenant.tokens.get(token!)!.has(permission)) {
      return respond(403, errorBody(['base'], `The API token lacks the ${permission} permission`), {}, route.spec)
    }

    try {
      const query = parseQuery(method.toLowerCase(), route.spec, url.searchParams)
      const ctx: Ctx = { tenant, url, params, query, body, now: now(), origin: url.origin, pageSize, opts }
      const out = route.handle(ctx)
      if (method === 'POST' && route.spec === '/public/v1/orders') {
        tenant.writes.push({ at: new Date(ctx.now).toISOString(), method, path: url.pathname, body, status: out.status })
      }
      return respond(out.status, out.body, out.headers, route.spec)
    } catch (e) {
      if (e instanceof HttpError) return respond(e.status, errorBody(e.pointer, e.message), e.headers, route.spec)
      if (e instanceof BadRequest) return respond(400, errorBody(e.pointer, e.message), {}, route.spec)
      throw e
    }
  }

  return {
    tenants,
    requests,
    fetch: (input, init) => handle(input instanceof Request ? input : new Request(input, init)),
  }
}

/** Convenience for tests: a stable fingerprint of a tenant's orders. */
export function ordersFingerprint(t: Tenant): string {
  return createHash('sha256').update(JSON.stringify(t.orders)).digest('hex').slice(0, 16)
}
