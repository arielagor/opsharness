import { createHash } from 'node:crypto'

/** Every record in this package is SYNTHETIC. No real company, licence or customer data. */

export type Permission =
  | 'products_permissions_view'
  | 'companies_permissions_view'
  | 'orders_permissions_view'
  | 'orders_permissions_create'
  | 'orders_permissions_edit'
  | 'invoices_permissions_view'
  | 'settings_permissions_price_tiers'
  | 'reports_permissions_sales_order_item_history'

export const ALL_PERMISSIONS: Permission[] = [
  'products_permissions_view',
  'companies_permissions_view',
  'orders_permissions_view',
  'orders_permissions_create',
  'orders_permissions_edit',
  'invoices_permissions_view',
  'settings_permissions_price_tiers',
  'reports_permissions_sales_order_item_history',
]

export type StrainType = 'INDICA' | 'INDICA_DOMINANT' | 'SATIVA' | 'SATIVA_DOMINANT' | 'HYBRID' | 'HIGH_CBD'
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'READY_TO_SHIP' | 'DELIVERING' | 'DELIVERED' | 'COMPLETED' | 'CANCELED'
export type PriceTierMode = 'AUTO' | 'OVERRIDE' | 'NONE'

export interface MStrain { id: string; name: string; type: StrainType; inserted: string }
export interface MCategory { id: string; name: string }
export interface MUnitType { id: string; name: string }
export interface MUser { id: string; email: string; fullName: string; inserted: string }

export interface MLocation { id: string; name: string; address: string; companyId?: string; licenseId?: string; licenseNumber?: string }

export interface MLicense {
  id: string
  number: string
  type: string
  active: boolean
  issue: string
  expiry: string
  inserted: string
}

export interface MCompany {
  /** The company RELATIONSHIP id (what orders reference as company_id). */
  id: string
  name: string
  legalName: string
  category: 'Dispensary' | 'Delivery' | 'Distributor' | 'Manufacturer' | 'Retail'
  email: string
  licenses: MLicense[]
  locations: MLocation[]
  inserted: string
  updated: string
}

export interface MProduct {
  id: string
  name: string
  sku: string
  upc?: string
  unitPrice: number
  strainId?: string
  categoryId: string
  brandId?: string
  unitTypeId: string
  isActive: boolean
  inserted: string
  updated: string
}

/** Product-level stock per location (every synthetic product uses PRODUCT tracking). */
export interface MStock { productId: string; locationId: string; active: number }

export interface MOrderItem {
  id: string
  productId: string
  quantity: number
  priceBase: number
  priceTierMode: PriceTierMode
  /** Set when AUTO mode matched a tier. */
  priceTierId?: string
  locationId?: string
  note?: string | null
  isSample: boolean
  inserted: string
}

export interface MOrder {
  id: string
  number: string
  companyId?: string
  status: OrderStatus
  orderDatetime: string
  dueDatetime: string
  deliveryDatetime?: string | null
  internalNotes?: string | null
  externalNotes?: string | null
  locationId?: string | null
  items: MOrderItem[]
  creatorId: string
  inserted: string
  updated: string
}

export interface MInvoice {
  id: string
  number: string
  orderId: string
  companyId: string
  invoiceDatetime: string
  dueDatetime: string
  paid: number
  inserted: string
  updated: string
}

export interface MPriceTier {
  id: string
  versionId: string
  name: string
  priceOrPercent: 'PRICE' | 'PERCENT'
  /** Percent off unit price, e.g. 10 for 10% off. */
  percent?: number
  price?: number
  oneOfCompanies: string[]
  oneOfProducts: string[]
  inserted: string
  updated: string
}

export interface WriteLogEntry { at: string; method: string; path: string; body: unknown; status: number }

export interface Tenant {
  id: string
  name: string
  /** API tokens (synthetic) and the Distru permissions each carries. */
  tokens: Map<string, Set<Permission>>
  admin: MUser
  warehouse: MLocation
  /** The tenant's own locations (warehouse first). */
  ownLocations: MLocation[]
  strains: MStrain[]
  categories: MCategory[]
  unitTypes: MUnitType[]
  products: MProduct[]
  stock: MStock[]
  companies: MCompany[]
  orders: MOrder[]
  invoices: MInvoice[]
  priceTiers: MPriceTier[]
  /** Every accepted write, for audits and eval assertions. */
  writes: WriteLogEntry[]
  /** Timestamps (ms) of successful PDF downloads, for the sliding-window rate limit. */
  pdfDownloads: number[]
  seq: { order: number; invoice: number; id: number }
}

/** Deterministic opaque ids. Callers must never parse them; they look like UUIDs on purpose. */
export function makeId(namespace: string, n: number | string): string {
  const h = createHash('sha256').update(`${namespace}:${n}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function nextId(t: Tenant, kind: string): string {
  t.seq.id += 1
  return makeId(`${t.id}:${kind}:runtime`, t.seq.id)
}

export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2)
}

export function qty(n: number): string {
  // Distru returns quantities as decimal strings such as "10.000000000".
  return n.toFixed(9)
}
