import type { DistruClient } from '@opsharness/distru-client'
import { DistruApiError } from '@opsharness/distru-client'
import type { Order, OrderItemRequest, OrderStatus, OrderUpsertRequest, Product } from '@opsharness/distru-contract'
import type { Principal } from '@opsharness/core'
import { newPlanId, planHash, type FieldChange, type LineView, type Plan, type PlanDiff } from './plans.js'

export class ProposeError extends Error {}

export interface ProposedLine {
  /** An existing line on the order. Omit for a new line. */
  line_id?: string
  product_id?: string
  quantity?: number
  price?: number
  price_tier_mode?: 'AUTO' | 'OVERRIDE' | 'NONE'
}

export interface ProposeInput {
  order_id?: string
  company_id?: string
  status?: OrderStatus
  order_datetime?: string
  due_datetime?: string
  internal_notes?: string
  external_notes?: string
  /**
   * Distru semantics, deliberately: when sent, this is the COMPLETE set of lines. An existing
   * line that is not listed is deleted. The diff names every such deletion.
   */
  items?: ProposedLine[]
  rationale: string
}

const num = (s: string | number | null | undefined) => (s === null || s === undefined ? 0 : Number(s))

function lineFromOrderItem(i: NonNullable<Order['items']>[number]): LineView {
  return {
    line_id: i.id,
    product_id: i.product?.id ?? '',
    product_name: i.product?.name ?? '(unknown product)',
    sku: i.product?.sku ?? '',
    quantity: num(i.quantity),
    price: num(i.price_base ?? i.price),
  }
}

async function loadProducts(client: DistruClient, ids: string[]): Promise<Map<string, Product>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const found = await client.listProducts({ ids: unique }).all()
  const map = new Map(found.map((p) => [p.id, p]))
  const missing = unique.filter((id) => !map.has(id))
  if (missing.length) throw new ProposeError(`Product not found in this account: ${missing.join(', ')}`)
  return map
}

function describeLine(l: LineView): string {
  return `${l.sku} "${l.product_name}" x${l.quantity} @ ${l.price.toFixed(2)}`
}

export function renderSummary(d: Omit<PlanDiff, 'summary'>): string {
  const out: string[] = []
  const who = d.customer ? ` for ${d.customer.name}` : ''
  out.push(d.kind === 'create' ? `CREATE new order${who}` : `UPDATE ${d.order_number ?? d.order_id}${who}`)
  for (const h of d.header) out.push(`  ${h.field}: ${JSON.stringify(h.from)} -> ${JSON.stringify(h.to)}`)
  for (const l of d.lines.added) out.push(`  + ADD     ${describeLine(l)}`)
  for (const l of d.lines.changed) out.push(`  ~ CHANGE  ${describeLine(l)} (${l.changes.map((c) => `${c.field} ${String(c.from)} -> ${String(c.to)}`).join(', ')})`)
  for (const l of d.lines.kept) out.push(`  = KEEP    ${describeLine(l)}`)
  for (const l of d.lines.deleted) out.push(`  - DELETE  ${describeLine(l)} [line ${l.line_id}]`)
  if (d.destructive) out.push(`DESTRUCTIVE: ${d.destructive_reasons.join('; ')}`)
  return out.join('\n')
}

/**
 * Computes a plan WITHOUT writing anything to Distru. Reads the current order, translates the
 * proposal into the exact upsert body Distru would receive, and diffs the two semantically.
 */
export async function proposeOrderChange(client: DistruClient, principal: Principal, input: ProposeInput, ctx: { now: () => Date; runId: string | null }): Promise<Plan> {
  if (!input.rationale?.trim()) throw new ProposeError('A rationale is required: say why this change is being proposed.')
  if (input.items && input.items.length === 0) throw new ProposeError('items: [] would remove every line; Distru rejects it. Omit items to leave lines unchanged.')

  const creating = !input.order_id
  let order: Order | undefined
  if (!creating) {
    try {
      order = await client.getOrder(input.order_id!)
    } catch (e) {
      if (e instanceof DistruApiError && e.isNotFound) throw new ProposeError('Order not found in this account.')
      throw e
    }
  }

  const header: FieldChange[] = []
  const request: OrderUpsertRequest = creating ? ({} as OrderUpsertRequest) : ({ id: order!.id } as OrderUpsertRequest)
  const setField = (field: keyof ProposeInput & keyof OrderUpsertRequest, current: unknown) => {
    const value = input[field]
    if (value === undefined) return
    if (!creating && value === current) return
    ;(request as Record<string, unknown>)[field] = value
    header.push({ field, from: creating ? null : (current ?? null), to: value })
  }

  let customer: PlanDiff['customer'] = order?.company ? { id: order.company.id, name: order.company.name } : null
  if (input.company_id !== undefined && input.company_id !== order?.company?.id) {
    try {
      const c = await client.getCompany(input.company_id)
      customer = { id: c.id, name: c.name }
    } catch (e) {
      if (e instanceof DistruApiError && e.isNotFound) throw new ProposeError('Customer (company_id) not found in this account.')
      throw e
    }
    request.company_id = input.company_id
    header.push({ field: 'company_id', from: order?.company?.id ?? null, to: input.company_id })
  }
  if (creating) {
    request.status = input.status ?? 'PENDING'
    request.order_datetime = input.order_datetime ?? ctx.now().toISOString()
    header.push({ field: 'status', from: null, to: request.status }, { field: 'order_datetime', from: null, to: request.order_datetime })
    if (input.due_datetime) setField('due_datetime', null)
    if (input.internal_notes !== undefined) setField('internal_notes', null)
    if (input.external_notes !== undefined) setField('external_notes', null)
  } else {
    setField('status', order!.status)
    setField('order_datetime', order!.order_datetime)
    setField('due_datetime', order!.due_datetime)
    setField('internal_notes', order!.internal_notes)
    setField('external_notes', order!.external_notes)
  }

  const current = new Map((order?.items ?? []).map((i) => [i.id, lineFromOrderItem(i)]))
  const lines: PlanDiff['lines'] = { added: [], changed: [], kept: [], deleted: [] }

  if (creating && !input.items?.length) throw new ProposeError('A new order needs at least one line.')
  if (input.items) {
    const products = await loadProducts(
      client,
      input.items.flatMap((l) => (l.product_id ? [l.product_id] : [])),
    )
    const seen = new Set<string>()
    const items: OrderItemRequest[] = []
    input.items.forEach((l, idx) => {
      if (l.quantity !== undefined && !(l.quantity > 0)) throw new ProposeError(`items[${idx}]: quantity must be greater than 0`)
      if (l.price !== undefined && !(l.price >= 0)) throw new ProposeError(`items[${idx}]: price must not be negative`)
      if (l.line_id) {
        const existing = current.get(l.line_id)
        if (!existing) throw new ProposeError(`items[${idx}]: line ${l.line_id} is not on this order. To add a line, omit line_id.`)
        if (seen.has(l.line_id)) throw new ProposeError(`items[${idx}]: line ${l.line_id} listed twice`)
        seen.add(l.line_id)
        const changes: FieldChange[] = []
        const next: LineView = { ...existing }
        const item: Record<string, unknown> = { id: l.line_id }
        if (l.product_id !== undefined && l.product_id !== existing.product_id) {
          const p = products.get(l.product_id)!
          changes.push({ field: 'product', from: existing.sku, to: p.sku })
          Object.assign(next, { product_id: p.id, product_name: p.name, sku: p.sku })
          item['product_id'] = l.product_id
        }
        if (l.quantity !== undefined && l.quantity !== existing.quantity) {
          changes.push({ field: 'quantity', from: existing.quantity, to: l.quantity })
          next.quantity = l.quantity
          item['quantity'] = l.quantity
        }
        if (l.price !== undefined && l.price !== existing.price) {
          changes.push({ field: 'price', from: existing.price, to: l.price })
          next.price = l.price
          item['price_base'] = l.price
        }
        if (l.price_tier_mode) item['price_tier_mode'] = l.price_tier_mode
        items.push(item as unknown as OrderItemRequest)
        if (changes.length) lines.changed.push({ ...next, changes })
        else lines.kept.push(existing)
        return
      }
      if (!l.product_id || l.quantity === undefined || l.price === undefined) {
        throw new ProposeError(`items[${idx}]: a new line needs product_id, quantity and price`)
      }
      const p = products.get(l.product_id)!
      items.push({ product_id: l.product_id, quantity: l.quantity, price_base: l.price, ...(l.price_tier_mode ? { price_tier_mode: l.price_tier_mode } : {}) } as unknown as OrderItemRequest)
      lines.added.push({ line_id: null, product_id: p.id, product_name: p.name, sku: p.sku, quantity: l.quantity, price: l.price })
    })
    for (const [id, line] of current) if (!seen.has(id)) lines.deleted.push(line)
    request.items = items
  }

  const destructive_reasons = lines.deleted.map((l) => `deletes line ${describeLine(l)} (line ${l.line_id})`)
  if (!creating && input.status === 'CANCELED' && order!.status !== 'CANCELED') destructive_reasons.push(`cancels order ${order!.order_number}`)

  const nothing = header.length === 0 && lines.added.length === 0 && lines.changed.length === 0 && lines.deleted.length === 0
  if (!creating && nothing) throw new ProposeError('This proposal changes nothing on the order.')

  const diffBase = {
    kind: creating ? ('create' as const) : ('update' as const),
    order_id: order?.id ?? null,
    order_number: order?.order_number ?? null,
    customer,
    header,
    lines,
    destructive: destructive_reasons.length > 0,
    destructive_reasons,
  }
  const diff: PlanDiff = { ...diffBase, summary: renderSummary(diffBase) }
  const base = {
    tenantId: principal.tenantId,
    orderId: order?.id ?? null,
    baseUpdatedDatetime: order?.updated_datetime ?? null,
    request,
  }
  return {
    id: newPlanId(),
    ...base,
    proposedBy: principal.id,
    runId: ctx.runId,
    diff,
    destructive: diff.destructive,
    rationale: input.rationale,
    hash: planHash(base),
    status: 'PROPOSED',
    createdAt: ctx.now().toISOString(),
  }
}
