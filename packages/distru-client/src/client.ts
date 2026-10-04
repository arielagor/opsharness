import type {
  CompaniesQuery,
  Company,
  Inventory,
  InventoryQuery,
  Invoice,
  InvoicesQuery,
  Order,
  OrdersQuery,
  OrderUpsertRequest,
  PdfResponse,
  PriceTier,
  PriceTiersQuery,
  Product,
  ProductsQuery,
  SalesOrderItemHistoryQuery,
  SalesOrderItemHistoryReport,
} from '@opsharness/distru-contract'
import { DistruApiError, DistruClientError, parseErrorEnvelope } from './errors.js'
import { buildQuery, type QueryValue } from './query.js'

export const API_PREFIX = '/public/v1'

export interface RequestEvent {
  method: string
  path: string
  status: number
  durationMs: number
  attempt: number
}

export interface DistruClientOptions {
  /** Origin of the API, e.g. `https://app.distru.com` (or the mock). Paths add `/public/v1`. */
  baseUrl: string
  /** Server-side only. Carries the permissions of the admin who created it. */
  token: string
  fetch?: typeof fetch
  /** Injected so tests and evals can observe the wait without sleeping. */
  sleep?: (ms: number) => Promise<void>
  /** How many times a 429 is retried after its Retry-After. Default 3. */
  maxRateLimitRetries?: number
  /** Observability hook: one call per HTTP attempt. */
  onRequest?: (event: RequestEvent) => void
}

/** Removes `page`: callers never build page selectors; only next_page drives paging. */
type NoPage<Q> = Omit<Q, 'page'>

interface ListEnvelope<T> {
  data: T[]
  next_page?: string | null
}

export interface Paginated<T> extends AsyncIterable<T[]> {
  /** Walks every page (following next_page until null) and returns all rows. */
  all(): Promise<T[]>
}

/**
 * Parses a Retry-After header: delta-seconds, or an HTTP-date. Returns undefined when absent
 * or unparseable, in which case the client does not invent a schedule.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, Math.ceil((date - now) / 1000))
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class DistruClient {
  private readonly origin: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  constructor(private readonly opts: DistruClientOptions) {
    this.origin = new URL(opts.baseUrl).origin
    this.fetchImpl = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? defaultSleep
    this.maxRetries = opts.maxRateLimitRetries ?? 3
  }

  /** Low-level request. `target` is a path under /public/v1, or an absolute next_page URL. */
  async request<T>(method: 'GET' | 'POST' | 'DELETE', target: string, init: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    const url = this.resolve(target, init.query)
    const path = new URL(url).pathname
    for (let attempt = 1; ; attempt++) {
      const started = performance.now()
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      this.opts.onRequest?.({ method, path, status: res.status, durationMs: performance.now() - started, attempt })

      if (res.ok) {
        const text = await res.text()
        return (text === '' ? undefined : JSON.parse(text)) as T
      }

      const body = await res.json().catch(() => undefined)
      const errors = parseErrorEnvelope(body)
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
        if (retryAfter !== undefined && attempt <= this.maxRetries) {
          // Honour Retry-After exactly: the window is sliding, so a fixed schedule wastes quota.
          await this.sleep(retryAfter * 1000)
          continue
        }
        throw new DistruApiError(429, errors, method, path, retryAfter)
      }
      // 400/401/403/404 are final; 5xx is a Distru bug, not a retry case. No 422 exists.
      throw new DistruApiError(res.status, errors, method, path)
    }
  }

  private resolve(target: string, query?: Record<string, QueryValue>): string {
    if (/^https?:\/\//.test(target)) {
      // A next_page URL: pass it back exactly as given, but never send the token to another host.
      if (new URL(target).origin !== this.origin) {
        throw new DistruClientError(`Refusing to follow next_page to a different origin: ${new URL(target).origin}`)
      }
      if (query && Object.keys(query).length > 0) throw new DistruClientError('A next_page URL is used verbatim; do not add query parameters.')
      return target
    }
    const qs = buildQuery(query)
    return `${this.origin}${API_PREFIX}${target}${qs ? `?${qs}` : ''}`
  }

  /** Follows next_page until it is null. Never assumes a page size or page count. */
  paginate<T>(path: string, query?: Record<string, QueryValue>): Paginated<T> {
    const get = <R>(target: string, q?: Record<string, QueryValue>) => this.request<R>('GET', target, q === undefined ? {} : { query: q })
    async function* pages(): AsyncGenerator<T[]> {
      let page = await get<ListEnvelope<T>>(path, query)
      yield page.data
      while (page.next_page) {
        page = await get<ListEnvelope<T>>(page.next_page)
        yield page.data
      }
    }
    return {
      [Symbol.asyncIterator]: pages,
      async all() {
        const rows: T[] = []
        for await (const data of pages()) rows.push(...data)
        return rows
      },
    }
  }

  private static id(id: string): string {
    if (typeof id !== 'string' || id === '') throw new DistruClientError('An id must be a non-empty opaque string.')
    return encodeURIComponent(id)
  }

  // ---- products -------------------------------------------------------------------------
  listProducts(query: NoPage<ProductsQuery> = {}): Paginated<Product> {
    return this.paginate<Product>('/products', query as Record<string, QueryValue>)
  }

  async getProduct(id: string): Promise<Product> {
    return (await this.request<{ data: Product }>('GET', `/products/${DistruClient.id(id)}`)).data
  }

  // ---- inventory ------------------------------------------------------------------------
  listInventory(query: NoPage<InventoryQuery>): Paginated<Inventory> {
    return this.paginate<Inventory>('/inventory', query as Record<string, QueryValue>)
  }

  // ---- companies ------------------------------------------------------------------------
  listCompanies(query: NoPage<CompaniesQuery> = {}): Paginated<Company> {
    return this.paginate<Company>('/companies', query as Record<string, QueryValue>)
  }

  async getCompany(id: string): Promise<Company> {
    return (await this.request<{ data: Company }>('GET', `/companies/${DistruClient.id(id)}`)).data
  }

  // ---- orders ---------------------------------------------------------------------------
  listOrders(query: NoPage<OrdersQuery> = {}): Paginated<Order> {
    return this.paginate<Order>('/orders', query as Record<string, QueryValue>)
  }

  async getOrder(id: string): Promise<Order> {
    return (await this.request<{ data: Order }>('GET', `/orders/${DistruClient.id(id)}`)).data
  }

  /**
   * Upsert: no `id` creates, an `id` updates (sparse). If `items` is sent it REPLACES the set:
   * an existing line whose id is omitted is deleted. Callers that write should go through a
   * reviewed plan (see @opsharness/mcp-distru), not call this directly.
   */
  async upsertOrder(body: OrderUpsertRequest): Promise<Order> {
    return (await this.request<{ data: Order }>('POST', '/orders', { body })).data
  }

  /** Rate limited (20/min, 1000/day per account across all PDF endpoints); 429 honours Retry-After. */
  async orderPdfUrl(id: string): Promise<NonNullable<PdfResponse['data']>> {
    const res = await this.request<PdfResponse>('POST', `/orders/${DistruClient.id(id)}/pdf`, { body: { format: 'url' } })
    return res.data ?? {}
  }

  // ---- invoices / price tiers / reports ---------------------------------------------------
  listInvoices(query: NoPage<InvoicesQuery> = {}): Paginated<Invoice> {
    return this.paginate<Invoice>('/invoices', query as Record<string, QueryValue>)
  }

  listPriceTiers(query: NoPage<PriceTiersQuery> = {}): Paginated<PriceTier> {
    return this.paginate<PriceTier>('/price-tiers', query as Record<string, QueryValue>)
  }

  /** Not paginated: the report returns every matching row in one response. */
  async salesOrderItemHistory(query: SalesOrderItemHistoryQuery = {}): Promise<SalesOrderItemHistoryReport> {
    return this.request<SalesOrderItemHistoryReport>('GET', '/reports/sales-order-item-history', { query: query as Record<string, QueryValue> })
  }
}

export function createDistruClient(opts: DistruClientOptions): DistruClient {
  return new DistruClient(opts)
}
