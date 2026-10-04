import type { LineView, Plan } from '@opsharness/mcp-distru'
import type { Toolbox } from './toolbox.js'
import type { Check, DraftLine, OrderDraft, Verdict } from './types.js'

export interface CatalogItem {
  product_id: string
  name: string
  sku: string | null
}

export type Match = { kind: 'unique'; product: CatalogItem } | { kind: 'ambiguous'; candidates: CatalogItem[] } | { kind: 'none' }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.:]+/g, ' ').trim()

/**
 * Deterministic product resolution for one source line. A SKU must match exactly. Without a SKU,
 * an exact name wins; otherwise every word of the description must appear in the name, and more
 * than one such product is AMBIGUOUS: the run must ask, whatever the model chose.
 */
export function matchProduct(line: Pick<DraftLine, 'description' | 'sku'>, catalog: CatalogItem[]): Match {
  if (line.sku) {
    const hit = catalog.filter((p) => p.sku?.toLowerCase() === line.sku!.toLowerCase())
    return hit.length === 1 ? { kind: 'unique', product: hit[0]! } : hit.length ? { kind: 'ambiguous', candidates: hit } : { kind: 'none' }
  }
  const want = norm(line.description)
  const exact = catalog.filter((p) => norm(p.name) === want)
  if (exact.length === 1) return { kind: 'unique', product: exact[0]! }
  const words = want.split(' ').filter(Boolean)
  const hits = catalog.filter((p) => words.every((w) => norm(p.name).split(' ').includes(w)))
  if (hits.length === 1) return { kind: 'unique', product: hits[0]! }
  return hits.length ? { kind: 'ambiguous', candidates: hits } : { kind: 'none' }
}

async function data(tb: Toolbox, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await tb.call(tool, args, { node: 'verifier' })
  if (r.isError) throw new Error(`verifier: ${tool} failed: ${r.text}`)
  return r.data
}

/**
 * The verifier is code, not a model. It re-reads Distru through its own read-only principal and
 * checks the PLAN (the exact request that would be sent) against the SOURCE (the draft):
 * licence, stock, price floor, one product per source line, and nothing the source did not ask for.
 */
export async function verify(input: { draft: OrderDraft; plan: Plan; toolbox: Toolbox; injectionSuspected: boolean }): Promise<Verdict> {
  const { draft, plan, toolbox } = input
  const checks: Check[] = []
  const blockers: string[] = []
  const warnings: string[] = []
  let needsClarification = false
  const check = (name: string, ok: boolean, detail: string, clarify = false) => {
    checks.push({ name, ok, detail })
    if (!ok) {
      blockers.push(detail)
      if (clarify) needsClarification = true
    }
  }

  const d = plan.diff
  const proposedLines: LineView[] = [...d.lines.added, ...d.lines.changed, ...d.lines.kept]
  const touched: (LineView & { need: number })[] = [
    ...d.lines.added.map((l) => ({ ...l, need: l.quantity })),
    ...d.lines.changed.map((l) => {
      const q = l.changes.find((c) => c.field === 'quantity')
      const p = l.changes.find((c) => c.field === 'product')
      return { ...l, need: p ? l.quantity : q ? Math.max(0, Number(q.to) - Number(q.from)) : 0 }
    }),
  ]

  // 1. Customer licence.
  const companyId = d.customer?.id
  if (!companyId) check('customer', false, 'The plan has no customer.')
  else {
    const c = ((await data(toolbox, 'find_customer', { company_id: companyId }))['customers'] as { name: string; can_receive_orders: boolean; licences: { number: string | null; expires: string | null; active: boolean }[] }[])[0]
    const ok = Boolean(c?.can_receive_orders)
    const lic = c?.licences.map((l) => `${l.number ?? 'unknown'} (${l.active ? 'active' : 'inactive'}, expires ${l.expires ?? 'never'})`).join(', ') || 'none on file'
    check('licence', ok, ok ? `${c!.name}: licence valid today.` : `${c?.name ?? companyId} cannot receive orders: no active, unexpired licence. On file: ${lic}.`)
  }

  // 1b. The customer the source names is the customer whose order the plan writes. An email from one
  // buyer citing another buyer's order number must not edit that order.
  const named = norm(draft.customer_name ?? '')
  if (named && d.customer) {
    const ok = norm(d.customer.name).includes(named)
    check('customer_matches_source', ok, ok ? `Source and plan both concern ${d.customer.name}.` : `The source is from "${draft.customer_name}", but the plan writes ${d.kind === 'update' ? `order ${d.order_number}, which belongs to` : 'an order for'} ${d.customer.name}.`)
  }

  // 2. One product per source line, and the plan matches the source.
  const matched = new Set<string>()
  for (const line of draft.lines) {
    const found = (await data(toolbox, 'search_products', { query: line.sku ?? line.description }))['products'] as CatalogItem[]
    const m = matchProduct(line, found)
    if (m.kind === 'ambiguous') {
      check('product_match', false, `"${line.description}" matches ${m.candidates.length} products (${m.candidates.map((c) => c.sku ?? c.name).join(', ')}). Ask the customer which one.`, true)
      continue
    }
    if (m.kind === 'none') {
      check('product_match', false, `"${line.sku ?? line.description}" does not match any product in this account.`, true)
      continue
    }
    matched.add(m.product.product_id)
    const inPlan = proposedLines.find((l) => l.product_id === m.product.product_id)
    if (!inPlan) check('plan_matches_source', false, `The source asks for ${line.quantity} x ${m.product.sku ?? m.product.name}, but the plan does not include it.`)
    else if (inPlan.quantity !== line.quantity) check('plan_matches_source', false, `${m.product.sku}: the source says ${line.quantity}, the plan says ${inPlan.quantity}.`)
    else if (line.unit_price != null && Math.abs(inPlan.price - line.unit_price) > 0.005) check('plan_matches_source', false, `${m.product.sku}: the source says ${line.unit_price.toFixed(2)}, the plan says ${inPlan.price.toFixed(2)}.`)
    else check('plan_matches_source', true, `${m.product.sku}: ${line.quantity} as requested.`)
  }
  for (const l of touched) {
    if (!matched.has(l.product_id) && !needsClarification) check('plan_matches_source', false, `The plan adds or changes ${l.sku} x${l.quantity}, which the source did not ask for.`)
  }

  // 3. Stock: available = active - reserved; a changed line needs only its increase.
  const ids = [...new Set(touched.filter((l) => l.need > 0).map((l) => l.product_id))]
  if (ids.length) {
    const rows = (await data(toolbox, 'get_inventory', { product_ids: ids }))['rows'] as { product_id: string; available: number | null }[]
    const avail = new Map(rows.map((r) => [r.product_id, r.available ?? 0]))
    for (const l of touched.filter((x) => x.need > 0)) {
      const a = avail.get(l.product_id) ?? 0
      check('inventory', l.need <= a, l.need <= a ? `${l.sku}: ${l.need} needed, ${a} available.` : `${l.sku}: ${l.need} needed but only ${a} available.`)
    }
  }

  // 4. Price floor for this customer.
  if (companyId && touched.length) {
    const prices = (await data(toolbox, 'get_customer_pricing', { company_id: companyId, product_ids: [...new Set(touched.map((l) => l.product_id))] }))['prices'] as { product_id: string; floor_price: number }[]
    const floor = new Map(prices.map((p) => [p.product_id, p.floor_price]))
    for (const l of touched) {
      const f = floor.get(l.product_id) ?? 0
      check('price_floor', l.price + 0.005 >= f, l.price + 0.005 >= f ? `${l.sku}: ${l.price.toFixed(2)} is at or above the floor ${f.toFixed(2)}.` : `${l.sku}: ${l.price.toFixed(2)} is below this customer's floor of ${f.toFixed(2)}.`)
    }
  }

  // 5. Held for a human with explicit acknowledgement, not blocked.
  if (plan.destructive) warnings.push(`DESTRUCTIVE: ${plan.diff.destructive_reasons.join(' ')} Approval requires acknowledging the deletions.`)
  if (input.injectionSuspected) warnings.push('The source contains text that looks like instructions to an AI system. It was treated as data; review the plan against the original message.')

  return { ok: blockers.length === 0, needsClarification, blockers, warnings, checks }
}
