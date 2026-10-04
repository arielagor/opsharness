import { money, qty, type MCompany, type MInvoice, type MLocation, type MOrder, type MOrderItem, type MPriceTier, type MProduct, type Tenant } from './model.js'

/** Internal records → the JSON shapes in Distru's OpenAPI spec. */

export function locationCompact(l: MLocation) {
  return {
    id: l.id,
    name: l.name,
    address: l.address,
    ...(l.companyId ? { company_id: l.companyId } : {}),
    ...(l.licenseId ? { license_id: l.licenseId } : {}),
  }
}

export function locationWithLicense(l: MLocation) {
  return { ...locationCompact(l), ...(l.licenseNumber ? { license_number: l.licenseNumber } : {}) }
}

export function allLocations(t: Tenant): MLocation[] {
  return [...t.ownLocations, ...t.companies.flatMap((c) => c.locations)]
}

export function findLocation(t: Tenant, id: string | null | undefined): MLocation | undefined {
  if (!id) return undefined
  return allLocations(t).find((l) => l.id === id)
}

/** Reserved = quantity on unfulfilled lines of PROCESSING orders (no package/batch assigned in this mock). */
export function reservedFor(t: Tenant, productId: string): number {
  let r = 0
  for (const o of t.orders) if (o.status === 'PROCESSING') for (const i of o.items) if (i.productId === productId) r += i.quantity
  return r
}

export function activeFor(t: Tenant, productId: string, locationId?: string): number {
  return t.stock.filter((s) => s.productId === productId && (!locationId || s.locationId === locationId)).reduce((a, s) => a + s.active, 0)
}

export function presentProduct(t: Tenant, p: MProduct) {
  const strain = t.strains.find((s) => s.id === p.strainId)
  const category = t.categories.find((c) => c.id === p.categoryId)
  const unit = t.unitTypes.find((u) => u.id === p.unitTypeId)
  const byLocation = t.stock
    .filter((s) => s.productId === p.id && s.active > 0)
    .sort((x, y) => x.locationId.localeCompare(y.locationId))
    .map((s) => ({ location: locationCompact(findLocation(t, s.locationId)!), quantity: qty(s.active) }))
  const active = activeFor(t, p.id)
  const reserved = reservedFor(t, p.id)
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    ...(p.upc ? { upc: p.upc } : {}),
    unit_price: money(p.unitPrice),
    inventory_tracking_method: 'PRODUCT' as const,
    is_active: p.isActive,
    is_featured: false,
    menu_visibility: 'DO_NOT_INCLUDE' as const,
    menus: [],
    tags: [],
    images: [],
    tasks: [],
    custom_data: [],
    quantity_active: qty(active),
    quantity_reserved: qty(reserved),
    quantity_available: qty(active - reserved),
    quantity_active_by_location: byLocation,
    ...(category ? { category: { id: category.id, name: category.name } } : {}),
    ...(unit ? { unit_type: { id: unit.id, name: unit.name } } : {}),
    ...(strain
      ? { strain: { id: strain.id, name: strain.name, strain_type: strain.type, inserted_datetime: strain.inserted, updated_datetime: strain.inserted } }
      : {}),
    inserted_datetime: p.inserted,
    updated_datetime: p.updated,
  }
}

export function companyCompact(c: MCompany) {
  return { id: c.id, name: c.name, tasks: [], updated_datetime: c.updated }
}

export function presentCompany(c: MCompany) {
  return {
    id: c.id,
    name: c.name,
    legal_business_name: c.legalName,
    category: c.category,
    default_email: c.email,
    custom_data: [],
    licenses: c.licenses.map((l) => ({
      id: l.id,
      license_number: l.number,
      license_type: l.type,
      active: l.active,
      issue_datetime: l.issue,
      expiry_datetime: l.expiry,
      inserted_datetime: l.inserted,
    })),
    locations: c.locations.map(locationCompact),
    inserted_datetime: c.inserted,
    updated_datetime: c.updated,
  }
}

export function tierFor(t: Tenant, companyId: string | undefined, productId: string): MPriceTier | undefined {
  if (!companyId) return undefined
  return t.priceTiers.find(
    (tier) =>
      (tier.oneOfCompanies.length === 0 || tier.oneOfCompanies.includes(companyId)) &&
      (tier.oneOfProducts.length === 0 || tier.oneOfProducts.includes(productId)),
  )
}

export function tierPrice(tier: MPriceTier, unitPrice: number): number {
  return tier.priceOrPercent === 'PRICE' ? tier.price! : unitPrice * (1 - tier.percent! / 100)
}

export function itemPrice(t: Tenant, order: MOrder, item: MOrderItem): number {
  if (item.priceTierMode === 'AUTO' && item.priceTierId) {
    const tier = t.priceTiers.find((x) => x.id === item.priceTierId)
    const product = t.products.find((p) => p.id === item.productId)
    if (tier && product) return tierPrice(tier, product.unitPrice)
  }
  void order
  return item.priceBase
}

export function orderTotal(t: Tenant, o: MOrder): number {
  return o.items.reduce((sum, i) => sum + i.quantity * itemPrice(t, o, i), 0)
}

function presentTier(tier: MPriceTier) {
  return {
    id: tier.id,
    name: tier.name,
    is_flat: tier.priceOrPercent === 'PRICE',
    price_or_percent: tier.priceOrPercent,
    ...(tier.percent !== undefined ? { percent: String(tier.percent) } : {}),
    ...(tier.price !== undefined ? { price: money(tier.price) } : {}),
  }
}

export function presentOrder(t: Tenant, o: MOrder) {
  const company = t.companies.find((c) => c.id === o.companyId)
  const location = findLocation(t, o.locationId)
  const creator = t.admin
  return {
    id: o.id,
    order_number: o.number,
    status: o.status,
    order_datetime: o.orderDatetime,
    due_datetime: o.dueDatetime,
    ...(o.deliveryDatetime !== undefined ? { delivery_datetime: o.deliveryDatetime } : {}),
    ...(o.internalNotes !== undefined ? { internal_notes: o.internalNotes } : {}),
    ...(o.externalNotes !== undefined ? { external_notes: o.externalNotes } : {}),
    ...(company ? { company: companyCompact(company) } : {}),
    ...(location ? { location: locationWithLicense(location) } : {}),
    total: money(orderTotal(t, o)),
    items: o.items.map((i) => {
      const product = t.products.find((p) => p.id === i.productId)!
      const tier = i.priceTierId ? t.priceTiers.find((x) => x.id === i.priceTierId) : undefined
      const itemLocation = findLocation(t, i.locationId)
      return {
        id: i.id,
        inserted_datetime: i.inserted,
        is_sample: i.isSample,
        quantity: qty(i.quantity),
        price_base: money(i.priceBase),
        price: money(itemPrice(t, o, i)),
        price_tier_mode: i.priceTierMode,
        ...(tier ? { price_tier_version: { id: tier.versionId, is_live: true, price_tier: presentTier(tier) } } : {}),
        ...(i.note !== undefined ? { note: i.note } : {}),
        ...(itemLocation ? { location: locationCompact(itemLocation) } : {}),
        product: presentProduct(t, product),
      }
    }),
    charges: [],
    invoices: t.invoices
      .filter((inv) => inv.orderId === o.id)
      .map((inv) => ({ id: inv.id, invoice_number: inv.number, status: invoiceStatus(t, inv), total: money(orderTotal(t, o)) })),
    returns: [],
    tasks: [],
    custom_data: [],
    creator: { id: creator.id, email: creator.email, full_name: creator.fullName, inserted_datetime: creator.inserted },
    inserted_datetime: o.inserted,
    updated_datetime: o.updated,
  }
}

export function invoiceStatus(t: Tenant, inv: MInvoice): 'NOT_PAID' | 'PARTIALLY_PAID' | 'FULLY_PAID' | 'OVER_PAID' {
  const order = t.orders.find((o) => o.id === inv.orderId)!
  const total = Math.round(orderTotal(t, order) * 100)
  const paid = Math.round(inv.paid * 100)
  if (paid === 0) return 'NOT_PAID'
  if (paid < total) return 'PARTIALLY_PAID'
  return paid === total ? 'FULLY_PAID' : 'OVER_PAID'
}

export function presentInvoice(t: Tenant, inv: MInvoice) {
  const order = t.orders.find((o) => o.id === inv.orderId)!
  const company = t.companies.find((c) => c.id === inv.companyId)
  const total = orderTotal(t, order)
  return {
    id: inv.id,
    invoice_number: inv.number,
    invoice_datetime: inv.invoiceDatetime,
    due_datetime: inv.dueDatetime,
    status: invoiceStatus(t, inv),
    total: money(total),
    paid_amount: money(inv.paid),
    remaining_amount: money(total - inv.paid),
    order: { id: order.id, order_number: order.number, status: order.status, total: money(total) },
    ...(company ? { company: companyCompact(company) } : {}),
    items: [],
    charges: [],
    payments: [],
    tasks: [],
    custom_data: [],
    inserted_datetime: inv.inserted,
    updated_datetime: inv.updated,
  }
}

/** Conditions embed full CompanyCompact and Product objects, not bare ids (the contract test caught this). */
export function presentPriceTier(t: Tenant, tier: MPriceTier) {
  return {
    ...presentTier(tier),
    current_version_id: tier.versionId,
    menu_mode: 'NONE' as const,
    menu_promo_card_type: 'TEXT' as const,
    menus: [],
    conditions: {
      one_of_companies: tier.oneOfCompanies.flatMap((id) => t.companies.filter((c) => c.id === id).map(companyCompact)),
      not_one_of_companies: [],
      one_of_company_relationship_groups: [],
      not_one_of_company_relationship_groups: [],
      one_of_products: tier.oneOfProducts.flatMap((id) => t.products.filter((p) => p.id === id).map((p) => presentProduct(t, p))),
      not_one_of_products: [],
      one_of_product_brands: [],
      not_one_of_product_brands: [],
      one_of_product_categories: [],
      not_one_of_product_categories: [],
      one_of_product_groups: [],
      not_one_of_product_groups: [],
      one_of_product_subcategories: [],
      not_one_of_product_subcategories: [],
      one_of_product_tags: [],
      not_one_of_product_tags: [],
    },
    inserted_datetime: tier.inserted,
    updated_datetime: tier.updated,
  }
}
