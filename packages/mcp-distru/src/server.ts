import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { DistruApiError, pointerToString, type DistruClient } from '@opsharness/distru-client'
import type { Company, Order, PriceTier } from '@opsharness/distru-contract'
import { hasScope, requireScope, ScopeError, truncateForAudit, type Principal, type Scope, type ToolCallListener } from '@opsharness/core'
import { currentRun, log, withSpan } from '@opsharness/telemetry'
import { applyPlan, ApplyError } from './apply.js'
import type { PlanStore } from './plans.js'
import { proposeOrderChange, ProposeError } from './propose.js'

export interface DistruServerOptions {
  principal: Principal
  /** Already bound to the principal's tenant credentials. */
  client: DistruClient
  plans: PlanStore
  now?: () => Date
  onToolCall?: ToolCallListener
  /** The harness run this server instance serves. Defaults to the ambient run context. */
  runId?: string | null
}

const ORDER_STATUSES = ['PENDING', 'PROCESSING', 'READY_TO_SHIP', 'DELIVERING', 'DELIVERED', 'COMPLETED', 'CANCELED'] as const
const num = (s: string | number | null | undefined) => (s === null || s === undefined || s === '' ? null : Number(s))

/** Error text a model may see. Never echoes another tenant's data: a 404 is just "not found". */
export function toolErrorMessage(e: unknown): string {
  if (e instanceof DistruApiError) {
    if (e.status === 404) return 'Not found in this account.'
    if (e.status === 403) return 'The Distru API token for this account lacks permission for this action.'
    if (e.status === 400) return `Distru rejected the request: ${e.errors.map((x) => `${pointerToString(x.pointer)}: ${x.message}`).join('; ')}`
    if (e.status === 429) return 'Distru rate limit reached and retries were exhausted. Try again later.'
    return `Distru returned ${e.status}.`
  }
  if (e instanceof ProposeError || e instanceof ApplyError || e instanceof ScopeError) return e.message
  return 'Internal error while calling Distru.'
}

function orderView(o: Order) {
  return {
    order_id: o.id,
    order_number: o.order_number,
    status: o.status,
    customer: o.company ? { company_id: o.company.id, name: o.company.name } : null,
    order_datetime: o.order_datetime,
    due_datetime: o.due_datetime ?? null,
    total: num(o.total),
    internal_notes: o.internal_notes ?? null,
    external_notes: o.external_notes ?? null,
    updated_datetime: o.updated_datetime,
    lines: (o.items ?? []).map((i) => ({
      line_id: i.id,
      product_id: i.product?.id ?? null,
      sku: i.product?.sku ?? null,
      product_name: i.product?.name ?? null,
      quantity: num(i.quantity),
      price: num(i.price_base ?? i.price),
      price_tier_mode: i.price_tier_mode ?? null,
    })),
  }
}

function customerView(c: Company, now: Date) {
  const licences = (c.licenses ?? []).map((l) => {
    const expires = l.expiry_datetime ?? null
    const valid = Boolean(l.active) && (expires === null || Date.parse(expires) > now.getTime())
    return { number: l.license_number ?? null, type: l.license_type ?? null, active: Boolean(l.active), expires, valid_today: valid }
  })
  return {
    company_id: c.id,
    name: c.name,
    category: c.category ?? null,
    licences,
    /** A buyer needs at least one active, unexpired licence. The verifier enforces this; it is shown here so the agent can ask early. */
    can_receive_orders: licences.some((l) => l.valid_today),
  }
}

export function tierUnitPrice(tier: PriceTier, unitPrice: number): number {
  if (tier.price_or_percent === 'PERCENT') return Math.round(unitPrice * (1 - Number(tier.percent ?? 0) / 100) * 100) / 100
  const p = Number(tier.price ?? 0)
  return tier.is_flat ? p : Math.max(0, Math.round((unitPrice - p) * 100) / 100)
}

/**
 * Builds an MCP server FOR one principal. A tool whose scope the principal lacks is not
 * registered, so it is not listed and cannot be called; each handler re-checks the scope too.
 * The tenant is the principal's, through `client`; no tool takes a tenant argument.
 */
export function buildDistruMcpServer(opts: DistruServerOptions): McpServer {
  const { principal, client, plans } = opts
  const now = opts.now ?? (() => new Date())
  const runIdNow = () => (opts.runId !== undefined ? opts.runId : (currentRun()?.runId ?? null))
  const server = new McpServer({ name: 'opsharness-distru', version: '0.1.0' }, { capabilities: { tools: {} } })

  function tool<S extends z.ZodRawShape>(
    name: string,
    scope: Scope,
    config: { description: string; input: S; readOnly: boolean; destructive?: boolean; idempotent?: boolean },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>,
  ) {
    if (!hasScope(principal, scope)) return
    server.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.input,
        annotations: { readOnlyHint: config.readOnly, destructiveHint: config.destructive ?? false, idempotentHint: config.idempotent ?? config.readOnly, openWorldHint: false },
      },
      (async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
        const startedAt = new Date()
        const t0 = performance.now()
        let ok = false
        let error: string | undefined
        let result: Record<string, unknown> | undefined
        const out = await withSpan(
          `mcp.tool ${name}`,
          { 'mcp.server': 'distru', 'mcp.tool': name, 'opsharness.principal_id': principal.id, 'opsharness.tenant_id': principal.tenantId },
          async (span): Promise<CallToolResult> => {
            try {
              requireScope(principal, scope)
              result = await handler(args)
              ok = true
              return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
            } catch (e) {
              error = toolErrorMessage(e)
              if (error === 'Internal error while calling Distru.') log.error('tool failed', { tool: name, err: (e as Error).stack })
              span.setAttribute('mcp.tool.error', error)
              return { isError: true, content: [{ type: 'text', text: error }] }
            }
          },
        )
        const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000
        log.info('mcp tool call', { server: 'distru', tool: name, principal_id: principal.id, ok, latency_ms: latencyMs })
        await opts.onToolCall?.({
          server: 'distru',
          tool: name,
          principalId: principal.id,
          tenantId: principal.tenantId,
          runId: runIdNow(),
          args,
          ok,
          ...(error ? { error } : {}),
          ...(result ? { result: truncateForAudit(result) } : {}),
          latencyMs,
          startedAt: startedAt.toISOString(),
        })
        return out
      }) as never,
    )
  }

  // ---- reads -------------------------------------------------------------------------------

  tool(
    'search_products',
    'products:read',
    {
      description: 'Find products in this account by name or SKU fragment, or by exact SKUs/ids. Returns price and units available.',
      input: {
        query: z.string().min(1).optional().describe('Case-insensitive fragment of the product name or SKU'),
        skus: z.array(z.string()).max(200).optional(),
        product_ids: z.array(z.string()).max(200).optional(),
      },
      readOnly: true,
    },
    async ({ query, skus, product_ids }) => {
      const byId = new Map<string, Awaited<ReturnType<typeof client.getProduct>>>()
      const add = (rows: Awaited<ReturnType<typeof client.getProduct>>[]) => rows.forEach((p) => byId.set(p.id, p))
      if (query) {
        add(await client.listProducts({ name: query }).all())
        add(await client.listProducts({ sku: query }).all())
      }
      if (skus?.length) add(await client.listProducts({ skus }).all())
      if (product_ids?.length) add(await client.listProducts({ ids: product_ids }).all())
      if (!query && !skus?.length && !product_ids?.length) add(await client.listProducts({ is_active: true }).all())
      const products = [...byId.values()].slice(0, 50).map((p) => ({
        product_id: p.id,
        name: p.name,
        sku: p.sku ?? null,
        unit_price: num(p.unit_price),
        quantity_available: num(p.quantity_available),
        category: p.category?.name ?? null,
        is_active: p.is_active ?? null,
      }))
      return { products, count: products.length }
    },
  )

  tool(
    'get_inventory',
    'inventory:read',
    {
      description: 'Units on hand per product (optionally per location): active, reserved by processing orders, and available = active - reserved.',
      input: { product_ids: z.array(z.string()).max(200).optional(), by_location: z.boolean().optional() },
      readOnly: true,
    },
    async ({ product_ids, by_location }) => {
      const rows = await client
        .listInventory({ groupings: by_location ? ['PRODUCT', 'LOCATION'] : ['PRODUCT'], ...(product_ids?.length ? { product_ids } : {}) })
        .all()
      return {
        rows: rows.map((r) => ({
          product_id: r.product_id ?? null,
          ...(by_location ? { location_id: r.location_id ?? null } : {}),
          active: num(r.active),
          reserved: num(r.reserved),
          available: num(r.available),
        })),
        note: 'Products with zero active and zero available units are omitted by Distru; a missing product means 0 available.',
      }
    },
  )

  tool(
    'find_customer',
    'companies:read',
    {
      description: 'Find a customer (company relationship) by name fragment, licence number, or id. Shows licence validity today.',
      input: { name: z.string().min(1).optional(), license_number: z.string().optional(), company_id: z.string().optional() },
      readOnly: true,
    },
    async ({ name, license_number, company_id }) => {
      const t = now()
      if (company_id) return { customers: [customerView(await client.getCompany(company_id), t)] }
      const rows = await client.listCompanies({ ...(name ? { name } : {}), ...(license_number ? { license_number } : {}) }).all()
      return { customers: rows.slice(0, 20).map((c) => customerView(c, t)) }
    },
  )

  tool(
    'get_order',
    'orders:read',
    { description: 'One order with its lines (line_id is needed to keep or change a line in a proposal).', input: { order_id: z.string().min(1) }, readOnly: true },
    async ({ order_id }) => ({ order: orderView(await client.getOrder(order_id)) }),
  )

  tool(
    'get_order_pdf',
    'orders:read',
    {
      description: 'A download link for the order PDF. Distru rate-limits this endpoint (20/min, 1000/day); the client waits out Retry-After before retrying.',
      input: { order_id: z.string().min(1) },
      readOnly: true,
    },
    async ({ order_id }) => {
      const pdf = await client.orderPdfUrl(order_id)
      return { order_id, pdf_url: pdf.url ?? null }
    },
  )

  tool(
    'list_orders',
    'orders:read',
    {
      description: 'Recent orders, newest first, filtered by status, customer, order number, or order date (inclusive).',
      input: {
        statuses: z.array(z.enum(ORDER_STATUSES)).optional(),
        company_id: z.string().optional(),
        order_number: z.string().optional(),
        since: z.string().datetime({ offset: true }).optional(),
      },
      readOnly: true,
    },
    async ({ statuses, company_id, order_number, since }) => {
      const rows = await client
        .listOrders({
          ...(statuses?.length ? { statuses } : {}),
          ...(company_id ? { company_ids: [company_id] } : {}),
          ...(order_number ? { order_number } : {}),
          ...(since ? { order_datetime: `${since},` } : {}),
        })
        .all()
      return {
        orders: rows.slice(0, 50).map((o) => ({
          order_id: o.id,
          order_number: o.order_number,
          status: o.status,
          customer: o.company?.name ?? null,
          total: num(o.total),
          order_datetime: o.order_datetime,
          line_count: o.items?.length ?? 0,
        })),
      }
    },
  )

  tool(
    'get_customer_pricing',
    'pricing:read',
    {
      description: "The price floor for a customer per product: list price, and the best applicable price tier. Quoting below the floor is blocked by the verifier.",
      input: { company_id: z.string().min(1), product_ids: z.array(z.string()).min(1).max(200) },
      readOnly: true,
    },
    async ({ company_id, product_ids }) => {
      const [products, tiers] = await Promise.all([client.listProducts({ ids: product_ids }).all(), client.listPriceTiers({ company_relationship_id: company_id }).all()])
      return {
        company_id,
        prices: products.map((p) => {
          const unit = Number(p.unit_price ?? 0)
          const applicable = tiers.filter((t) => {
            const c = t.conditions
            const companies = c.one_of_companies.map((x) => x.id)
            const prods = c.one_of_products.map((x) => x.id)
            return (companies.length === 0 || companies.includes(company_id)) && (prods.length === 0 || prods.includes(p.id))
          })
          const best = applicable.map((t) => ({ t, price: tierUnitPrice(t, unit) })).sort((a, b) => a.price - b.price)[0]
          return {
            product_id: p.id,
            sku: p.sku ?? null,
            name: p.name,
            unit_price: unit,
            tier_name: best?.t.name ?? null,
            tier_price: best?.price ?? null,
            floor_price: best?.price ?? unit,
          }
        }),
      }
    },
  )

  tool(
    'sales_history',
    'reports:read',
    {
      description: 'Sales order line history (Distru report; not paginated; defaults to the last 30 days). Useful to see what a customer usually orders.',
      input: { company_id: z.string().optional(), since: z.string().datetime({ offset: true }).optional() },
      readOnly: true,
    },
    async ({ company_id, since }) => {
      const report = await client.salesOrderItemHistory({
        ...(company_id ? { company_relationship_ids: [company_id] } : {}),
        ...(since ? { order_datetime: `${since},` } : {}),
      })
      return {
        rows: report.data.slice(0, 100).map((r) => ({
          order_number: r.order_number ?? null,
          order_date: r.order_date ?? null,
          status: r.status ?? null,
          customer: r.customer ?? null,
          product_id: r.product_id ?? null,
          sku: r.product_sku ?? null,
          product: r.product ?? null,
          quantity: num(r.quantity),
          price: num(r.order_item_price),
        })),
        row_count: report.data.length,
      }
    },
  )

  // ---- two-phase writes ------------------------------------------------------------------------

  tool(
    'propose_order_change',
    'orders:propose',
    {
      description:
        'Propose creating or changing a sales order. NOTHING is written to Distru: this returns a plan with a semantic diff for a human to approve. ' +
        'If you send `items`, it is the COMPLETE list of lines: any existing line you leave out will be DELETED (the plan is then marked destructive). ' +
        'To keep a line unchanged send just {line_id}. To add a line omit line_id and give product_id, quantity and price.',
      input: {
        order_id: z.string().optional().describe('Omit to create a new order'),
        company_id: z.string().optional(),
        status: z.enum(ORDER_STATUSES).optional(),
        order_datetime: z.string().datetime({ offset: true }).optional(),
        due_datetime: z.string().datetime({ offset: true }).optional(),
        internal_notes: z.string().max(2000).optional(),
        external_notes: z.string().max(2000).optional(),
        items: z
          .array(
            z.object({
              line_id: z.string().optional(),
              product_id: z.string().optional(),
              quantity: z.number().positive().optional(),
              price: z.number().nonnegative().optional(),
              price_tier_mode: z.enum(['AUTO', 'OVERRIDE', 'NONE']).optional(),
            }),
          )
          .optional(),
        rationale: z.string().min(1).max(2000).describe('Why this change: cite the source (email, sheet row) it came from'),
      },
      readOnly: false,
      destructive: false,
      idempotent: false,
    },
    async (input) => {
      const plan = await proposeOrderChange(client, principal, input, { now, runId: runIdNow() })
      await plans.create(plan)
      return {
        plan_id: plan.id,
        plan_hash: plan.hash,
        status: plan.status,
        destructive: plan.destructive,
        destructive_reasons: plan.diff.destructive_reasons,
        diff: plan.diff,
        next_step: 'A human must approve this plan in the approvals inbox before anything is written.',
      }
    },
  )

  tool(
    'get_plan',
    'orders:propose',
    { description: 'Status of a plan this account proposed (PROPOSED, APPROVED, REJECTED, APPLYING, APPLIED, FAILED).', input: { plan_id: z.string().min(1) }, readOnly: true },
    async ({ plan_id }) => {
      const plan = await plans.get(principal.tenantId, plan_id)
      if (!plan) throw new ApplyError('Plan not found.')
      return { plan_id: plan.id, status: plan.status, destructive: plan.destructive, summary: plan.diff.summary, ...(plan.error ? { error: plan.error } : {}), ...(plan.result ? { result: plan.result } : {}) }
    },
  )

  tool(
    'apply_plan',
    'orders:apply',
    {
      description: 'Execute a plan that a human has approved. Idempotent per plan: a second call returns the stored result and writes nothing.',
      input: { plan_id: z.string().min(1) },
      readOnly: false,
      destructive: true,
      idempotent: true,
    },
    async ({ plan_id }) => {
      const outcome = await applyPlan(client, plans, principal, plan_id, now)
      return { ...outcome }
    },
  )

  // The SDK installs tools/list only on the first registration; without this a principal granted
  // no Distru tools gets JSON-RPC -32601 instead of an empty list.
  server.registerTool('__init', { description: 'placeholder' }, () => ({ content: [] })).remove()
  return server
}

/** The tool names a principal would see, without building a server. Used by docs and tests. */
export const TOOL_SCOPES: Record<string, Scope> = {
  search_products: 'products:read',
  get_inventory: 'inventory:read',
  find_customer: 'companies:read',
  get_order: 'orders:read',
  get_order_pdf: 'orders:read',
  list_orders: 'orders:read',
  get_customer_pricing: 'pricing:read',
  sales_history: 'reports:read',
  propose_order_change: 'orders:propose',
  get_plan: 'orders:propose',
  apply_plan: 'orders:apply',
}
