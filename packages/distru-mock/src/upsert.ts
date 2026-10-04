import { nextId, type MOrder, type MOrderItem, type OrderStatus, type PriceTierMode, type Tenant } from './model.js'
import { tierFor } from './present.js'
import { BadRequest } from './query.js'

export class NotFound extends Error {
  constructor(readonly pointer: (string | number)[]) {
    super('Not Found')
  }
}

interface ItemInput {
  id?: string | null
  product_id?: string | null
  quantity?: number | null
  price_base?: number | null
  price_tier_mode?: PriceTierMode | null
  location_id?: string | null
  note?: string | null
  is_sample?: boolean | null
}

export interface OrderInput {
  id?: string
  company_id?: string | null
  status?: OrderStatus | null
  order_datetime?: string | null
  due_datetime?: string | null
  delivery_datetime?: string | null
  internal_notes?: string | null
  external_notes?: string | null
  location_id?: string | null
  items?: ItemInput[] | null
  [k: string]: unknown
}

const FULFILMENT_STATUSES: OrderStatus[] = ['READY_TO_SHIP', 'DELIVERING', 'DELIVERED', 'COMPLETED']

/**
 * POST /public/v1/orders, as documented:
 *  - no `id` creates (items, status and order_datetime required); an `id` updates, sparsely,
 *  - an `id` that does not exist on THIS account is a 404 (another account's id included),
 *  - `items`, when sent, REPLACES the set: an existing line whose id is omitted is DELETED,
 *    `{id}` alone keeps a line, `{id, ...fields}` patches it, an entry without a known id is added,
 *  - `items: []` is rejected (an order must keep one line),
 *  - the whole upsert is atomic: on any 400 nothing changes.
 * Returns the saved order. Works on a copy and swaps it in only when everything validated.
 */
export function upsertOrder(t: Tenant, body: OrderInput, now: string): MOrder {
  const creating = body.id === undefined || body.id === null
  const existing = creating ? undefined : t.orders.find((o) => o.id === body.id)
  if (!creating && !existing) throw new NotFound(['id'])

  if (creating) {
    if (body.items === undefined || body.items === null) throw new BadRequest(['items'], 'Items are required to create an order')
    if (!body.status) throw new BadRequest(['status'], 'Status is required to create an order')
    if (!body.order_datetime) throw new BadRequest(['order_datetime'], 'Order date is required to create an order')
  }
  for (const field of ['status', 'order_datetime', 'items'] as const) {
    if (body[field] === null) throw new BadRequest([field], `${field} cannot be null`)
  }

  const draft: MOrder = existing
    ? structuredClone(existing)
    : {
        id: nextId(t, 'order'),
        number: `SO-${t.seq.order + 1}`,
        status: body.status!,
        orderDatetime: body.order_datetime!,
        dueDatetime: body.order_datetime!,
        items: [],
        creatorId: t.admin.id,
        inserted: now,
        updated: now,
      }

  if (body.company_id === null) {
    if (draft.companyId) throw new BadRequest(['company_id'], 'Once a customer is set it cannot be cleared')
  } else if (body.company_id !== undefined) {
    if (!t.companies.some((c) => c.id === body.company_id)) throw new BadRequest(['company_id'], 'Not Found')
    draft.companyId = body.company_id
  }
  if (body.status) draft.status = body.status
  if (body.order_datetime) draft.orderDatetime = body.order_datetime
  if (body.due_datetime !== undefined) draft.dueDatetime = body.due_datetime ?? draft.orderDatetime
  else if (creating) draft.dueDatetime = draft.orderDatetime
  if (body.delivery_datetime !== undefined) draft.deliveryDatetime = body.delivery_datetime
  if (body.internal_notes !== undefined) draft.internalNotes = body.internal_notes
  if (body.external_notes !== undefined) draft.externalNotes = body.external_notes
  if (body.location_id !== undefined) {
    if (body.location_id !== null && !t.ownLocations.some((l) => l.id === body.location_id)) throw new BadRequest(['location_id'], 'Not Found')
    draft.locationId = body.location_id
  }

  if (body.items !== undefined && body.items !== null) {
    if (body.items.length === 0) throw new BadRequest(['items'], 'An order must keep at least one item')
    const byId = new Map(draft.items.map((i) => [i.id, i]))
    const next: MOrderItem[] = []
    const seen = new Set<string>()
    body.items.forEach((entry, idx) => {
      const ptr = (f: string) => ['items', idx, f]
      const current = entry.id ? byId.get(entry.id) : undefined
      if (entry.id && seen.has(entry.id)) throw new BadRequest(ptr('id'), 'Duplicate item id')
      if (entry.id) seen.add(entry.id)
      for (const f of ['quantity', 'price_base', 'product_id'] as const) if (entry[f] === null) throw new BadRequest(ptr(f), `${f} cannot be null`)

      if (current) {
        // Patch (or keep, when only the id was sent).
        const patched = { ...current }
        if (entry.product_id !== undefined && entry.product_id !== current.productId) {
          if (!t.products.some((p) => p.id === entry.product_id)) throw new BadRequest(ptr('product_id'), 'Not Found')
          patched.productId = entry.product_id!
        }
        if (entry.quantity !== undefined) patched.quantity = entry.quantity!
        if (entry.price_base !== undefined) patched.priceBase = entry.price_base!
        if (entry.price_tier_mode) patched.priceTierMode = entry.price_tier_mode
        if (entry.location_id !== undefined) patched.locationId = entry.location_id ?? undefined
        if (entry.note !== undefined) patched.note = entry.note
        if (entry.is_sample !== undefined && entry.is_sample !== null) patched.isSample = entry.is_sample
        if (patched.quantity <= 0) throw new BadRequest(ptr('quantity'), 'Quantity must be greater than 0')
        next.push(patched)
        return
      }

      // New line: product_id, quantity and price_base are required.
      if (!entry.product_id) throw new BadRequest(ptr('product_id'), 'Product is required for a new line')
      if (!t.products.some((p) => p.id === entry.product_id)) throw new BadRequest(ptr('product_id'), 'Not Found')
      if (entry.quantity === undefined) throw new BadRequest(ptr('quantity'), 'Quantity is required')
      if (entry.price_base === undefined) throw new BadRequest(ptr('price_base'), 'Price is required')
      if (entry.quantity! <= 0) throw new BadRequest(ptr('quantity'), 'Quantity must be greater than 0')
      if (entry.location_id && !t.ownLocations.some((l) => l.id === entry.location_id)) throw new BadRequest(ptr('location_id'), 'Not Found')
      next.push({
        id: entry.id ?? nextId(t, 'order-item'),
        productId: entry.product_id,
        quantity: entry.quantity!,
        priceBase: entry.price_base!,
        priceTierMode: entry.price_tier_mode ?? 'NONE',
        locationId: entry.location_id ?? t.warehouse.id,
        ...(entry.note !== undefined ? { note: entry.note } : {}),
        isSample: entry.is_sample ?? false,
        inserted: now,
      })
    })
    draft.items = next
  }

  // AUTO price-tier mode: lock to the best applicable tier.
  for (const item of draft.items) {
    if (item.priceTierMode === 'AUTO') {
      const tier = tierFor(t, draft.companyId, item.productId)
      if (tier) item.priceTierId = tier.id
      else delete item.priceTierId
    } else delete item.priceTierId
  }

  if (FULFILMENT_STATUSES.includes(draft.status) && !draft.companyId) {
    throw new BadRequest(['status'], `A customer (company_id) is required to move an order to ${draft.status}`)
  }

  draft.updated = now
  if (existing) {
    t.orders[t.orders.indexOf(existing)] = draft
  } else {
    t.seq.order += 1
    t.orders.push(draft)
  }
  return draft
}
