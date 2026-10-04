import {
  ALL_PERMISSIONS,
  makeId,
  type MCompany,
  type MLicense,
  type MLocation,
  type MOrder,
  type MOrderItem,
  type MProduct,
  type Permission,
  type StrainType,
  type Tenant,
} from './model.js'

/**
 * SYNTHETIC seed data: two fictional cannabis distributors ("tenants", i.e. two Distru
 * accounts), their catalog, stock, buyer companies with licences, orders and invoices.
 * Every name carries a [SYNTHETIC] marker. Licence numbers use a SYN- prefix that no state issues.
 */

export const SYNTHETIC = '[SYNTHETIC]'

/** Synthetic API tokens for the mock only. They grant nothing anywhere else. */
export const MOCK_TOKENS = {
  tenantAFull: 'mock-token-tenant-a-full',
  tenantAReadOnly: 'mock-token-tenant-a-readonly',
  tenantBFull: 'mock-token-tenant-b-full',
} as const

export const TENANT_A = 'tenant-a'
export const TENANT_B = 'tenant-b'

const EPOCH = Date.parse('2026-09-01T15:00:00.000Z')
const at = (days: number, hours = 0) => new Date(EPOCH + days * 86_400_000 + hours * 3_600_000).toISOString()

const READ_ONLY: Permission[] = ALL_PERMISSIONS.filter((p) => !p.endsWith('_create') && !p.endsWith('_edit'))

interface ProductSpec { key: string; name: string; sku: string; price: number; strain?: string; category: string; unit: string }

function buildTenant(opts: {
  id: string
  name: string
  domain: string
  tokens: [string, Permission[]][]
  strains: [string, StrainType][]
  categories: string[]
  products: ProductSpec[]
  stock: [string, number, 'main' | 'overflow'][]
  buyers: { key: string; name: string; category: MCompany['category']; licence: { number: string; active: boolean; expiry: string } }[]
}): Tenant & { keys: Record<string, string> } {
  const id = (kind: string, key: string) => makeId(`${opts.id}:${kind}`, key)
  const keys: Record<string, string> = {}
  const admin = { id: id('user', 'admin'), email: `ops@${opts.domain}`, fullName: `Ops Admin ${SYNTHETIC}`, inserted: at(-200) }
  const ownLicenceId = id('licence', 'own')
  const warehouse: MLocation = {
    id: id('location', 'main'),
    name: `Main Warehouse ${SYNTHETIC}`,
    address: '100 Example Way, Sample City, CA 90000',
    licenseId: ownLicenceId,
    licenseNumber: `SYN-C11-${opts.id.toUpperCase()}-0001`,
  }
  const overflow: MLocation = { id: id('location', 'overflow'), name: `Overflow Vault ${SYNTHETIC}`, address: '102 Example Way, Sample City, CA 90000' }
  keys['location:main'] = warehouse.id
  keys['location:overflow'] = overflow.id

  const strains = opts.strains.map(([name, type], i) => ({ id: id('strain', name), name, type, inserted: at(-180 + i) }))
  const categories = opts.categories.map((name) => ({ id: id('category', name), name }))
  const unitTypes = ['Each', 'Gram'].map((name) => ({ id: id('unit', name), name }))

  const products: MProduct[] = opts.products.map((p, i) => {
    const pid = id('product', p.key)
    keys[`product:${p.key}`] = pid
    return {
      id: pid,
      name: p.name,
      sku: p.sku,
      unitPrice: p.price,
      ...(p.strain ? { strainId: id('strain', p.strain) } : {}),
      categoryId: id('category', p.category),
      unitTypeId: id('unit', p.unit),
      isActive: true,
      inserted: at(-150 + i),
      updated: at(-150 + i),
    }
  })

  const stock = opts.stock.map(([key, active, where]) => ({
    productId: id('product', key),
    locationId: where === 'main' ? warehouse.id : overflow.id,
    active,
  }))

  const companies: MCompany[] = opts.buyers.map((b, i) => {
    const cid = id('company', b.key)
    keys[`company:${b.key}`] = cid
    const lic: MLicense = {
      id: id('licence', b.key),
      number: b.licence.number,
      type: b.category === 'Delivery' ? 'Retailer (Non-Storefront)' : 'Retailer',
      active: b.licence.active,
      issue: at(-400),
      expiry: b.licence.expiry,
      inserted: at(-120 + i),
    }
    return {
      id: cid,
      name: b.name,
      legalName: `${b.name.replace(` ${SYNTHETIC}`, '')} LLC ${SYNTHETIC}`,
      category: b.category,
      email: `orders@${b.key}.synthetic.example`,
      licenses: [lic],
      locations: [
        { id: id('buyer-location', b.key), name: `${b.name} storefront`, address: `${200 + i} Sample Street, Sample City, CA 90000`, companyId: cid, licenseId: lic.id, licenseNumber: lic.number },
      ],
      inserted: at(-120 + i),
      updated: at(-120 + i),
    }
  })

  for (const [token] of opts.tokens) keys[`token:${token}`] = token

  return {
    id: opts.id,
    name: opts.name,
    tokens: new Map(opts.tokens.map(([t, perms]) => [t, new Set(perms)])),
    admin,
    warehouse,
    ownLocations: [warehouse, overflow],
    strains,
    categories,
    unitTypes,
    products,
    stock,
    companies,
    orders: [],
    invoices: [],
    priceTiers: [],
    writes: [],
    pdfDownloads: [],
    seq: { order: 1000, invoice: 5000, id: 0 },
    keys,
  }
}

function addOrder(
  t: Tenant & { keys: Record<string, string> },
  o: { key: string; company: string; status: MOrder['status']; day: number; lines: [string, number, number][] },
): MOrder {
  t.seq.order += 1
  const oid = makeId(`${t.id}:order`, o.key)
  t.keys[`order:${o.key}`] = oid
  const items: MOrderItem[] = o.lines.map(([product, quantity, price], i) => {
    const itemId = makeId(`${t.id}:order-item`, `${o.key}:${i}`)
    t.keys[`item:${o.key}:${i}`] = itemId
    return {
      id: itemId,
      productId: t.keys[`product:${product}`]!,
      quantity,
      priceBase: price,
      priceTierMode: 'OVERRIDE',
      locationId: t.warehouse.id,
      isSample: false,
      inserted: at(o.day),
    }
  })
  const order: MOrder = {
    id: oid,
    number: `SO-${t.seq.order}`,
    companyId: t.keys[`company:${o.company}`]!,
    status: o.status,
    orderDatetime: at(o.day),
    dueDatetime: at(o.day + 30),
    locationId: t.warehouse.id,
    items,
    creatorId: t.admin.id,
    inserted: at(o.day),
    updated: at(o.day),
  }
  t.orders.push(order)
  return order
}

function addInvoice(t: Tenant, order: MOrder, paid: number) {
  t.seq.invoice += 1
  t.invoices.push({
    id: makeId(`${t.id}:invoice`, order.number),
    number: `INV-${t.seq.invoice}`,
    orderId: order.id,
    companyId: order.companyId!,
    invoiceDatetime: order.orderDatetime,
    dueDatetime: order.dueDatetime,
    paid,
    inserted: order.inserted,
    updated: order.updated,
  })
}

export type SeededTenant = Tenant & { keys: Record<string, string> }

export function seedTenants(): Map<string, SeededTenant> {
  const a = buildTenant({
    id: TENANT_A,
    name: `Larkspur & Vine Distribution ${SYNTHETIC}`,
    domain: 'larkspur-vine.synthetic.example',
    tokens: [
      [MOCK_TOKENS.tenantAFull, ALL_PERMISSIONS],
      [MOCK_TOKENS.tenantAReadOnly, READ_ONLY],
    ],
    strains: [
      ['Blue Dream', 'HYBRID'],
      ['Sour Diesel', 'SATIVA'],
      ['Granddaddy Purple', 'INDICA'],
      ['Harlequin', 'HIGH_CBD'],
      ['Pineapple Express', 'HYBRID'],
    ],
    categories: ['Flower', 'Pre-Roll', 'Vape', 'Edible', 'Tincture', 'Concentrate'],
    products: [
      { key: 'bd-flower', name: 'Blue Dream 3.5g Flower', sku: 'BD-FL-35', price: 25, strain: 'Blue Dream', category: 'Flower', unit: 'Each' },
      { key: 'bd-preroll', name: 'Blue Dream 1g Pre-Roll', sku: 'BD-PR-1', price: 8, strain: 'Blue Dream', category: 'Pre-Roll', unit: 'Each' },
      { key: 'sd-flower', name: 'Sour Diesel 3.5g Flower', sku: 'SD-FL-35', price: 26, strain: 'Sour Diesel', category: 'Flower', unit: 'Each' },
      { key: 'sd-vape', name: 'Sour Diesel 0.5g Vape Cartridge', sku: 'SD-VC-05', price: 22, strain: 'Sour Diesel', category: 'Vape', unit: 'Each' },
      { key: 'gdp-flower', name: 'Granddaddy Purple 3.5g Flower', sku: 'GDP-FL-35', price: 27, strain: 'Granddaddy Purple', category: 'Flower', unit: 'Each' },
      { key: 'gdp-gummies', name: 'Granddaddy Purple 100mg Gummies', sku: 'GDP-ED-100', price: 20, strain: 'Granddaddy Purple', category: 'Edible', unit: 'Each' },
      { key: 'hq-tincture', name: 'Harlequin 1:1 Tincture 30ml', sku: 'HQ-TN-30', price: 35, strain: 'Harlequin', category: 'Tincture', unit: 'Each' },
      { key: 'pe-preroll-5pk', name: 'Pineapple Express 1g Pre-Roll 5-Pack', sku: 'PE-PR-5PK', price: 30, strain: 'Pineapple Express', category: 'Pre-Roll', unit: 'Each' },
      { key: 'pe-flower', name: 'Pineapple Express 3.5g Flower', sku: 'PE-FL-35', price: 26, strain: 'Pineapple Express', category: 'Flower', unit: 'Each' },
      { key: 'hb-disposable', name: 'House Blend 0.5g Disposable Vape', sku: 'HB-VD-05', price: 18, category: 'Vape', unit: 'Each' },
      { key: 'sd-live-resin', name: 'Sour Diesel 1g Live Resin', sku: 'SD-LR-1', price: 32, strain: 'Sour Diesel', category: 'Concentrate', unit: 'Each' },
    ],
    stock: [
      ['bd-flower', 140, 'main'],
      ['bd-flower', 30, 'overflow'],
      ['bd-preroll', 300, 'main'],
      ['sd-flower', 60, 'main'],
      ['sd-vape', 12, 'main'],
      ['gdp-flower', 75, 'main'],
      ['gdp-gummies', 40, 'main'],
      ['hq-tincture', 24, 'main'],
      ['pe-preroll-5pk', 80, 'main'],
      ['pe-flower', 0, 'main'],
      ['hb-disposable', 150, 'main'],
      ['sd-live-resin', 18, 'main'],
    ],
    buyers: [
      { key: 'harborview', name: `Harborview Wellness ${SYNTHETIC}`, category: 'Dispensary', licence: { number: 'SYN-C10-0000101', active: true, expiry: '2027-06-30T00:00:00Z' } },
      { key: 'tamarack', name: `Tamarack Hollow Collective ${SYNTHETIC}`, category: 'Dispensary', licence: { number: 'SYN-C10-0000102', active: false, expiry: '2026-08-31T00:00:00Z' } },
      { key: 'pelican', name: `Pelican Point Retail ${SYNTHETIC}`, category: 'Retail', licence: { number: 'SYN-C10-0000103', active: true, expiry: '2027-03-31T00:00:00Z' } },
      { key: 'juniper', name: `Juniper Row Delivery ${SYNTHETIC}`, category: 'Delivery', licence: { number: 'SYN-C9-0000104', active: true, expiry: '2027-01-31T00:00:00Z' } },
      { key: 'cinder', name: `Cinder Lane Dispensary ${SYNTHETIC}`, category: 'Dispensary', licence: { number: 'SYN-C10-0000105', active: true, expiry: '2027-09-30T00:00:00Z' } },
      { key: 'larkspur-brand', name: `Larkspur House Brand ${SYNTHETIC}`, category: 'Manufacturer', licence: { number: 'SYN-CDPH-0000106', active: true, expiry: '2027-12-31T00:00:00Z' } },
    ],
  })

  const so1 = addOrder(a, { key: 'so-1', company: 'harborview', status: 'COMPLETED', day: 9, lines: [['bd-flower', 24, 25], ['pe-preroll-5pk', 10, 30]] })
  const so2 = addOrder(a, { key: 'so-2', company: 'pelican', status: 'COMPLETED', day: 17, lines: [['gdp-gummies', 20, 18]] })
  addOrder(a, { key: 'so-3', company: 'harborview', status: 'PENDING', day: 27, lines: [['bd-flower', 20, 25], ['sd-vape', 4, 22]] })
  addOrder(a, { key: 'so-4', company: 'pelican', status: 'PROCESSING', day: 28, lines: [['gdp-gummies', 30, 18]] })
  addOrder(a, { key: 'so-5', company: 'cinder', status: 'PENDING', day: 29, lines: [['hq-tincture', 6, 35]] })
  addOrder(a, { key: 'so-6', company: 'juniper', status: 'CANCELED', day: 19, lines: [['hb-disposable', 12, 18]] })
  addInvoice(a, so1, 900)
  addInvoice(a, so2, 0)

  a.priceTiers.push(
    {
      id: makeId(`${TENANT_A}:tier`, 'pelican-10'),
      versionId: makeId(`${TENANT_A}:tier-version`, 'pelican-10'),
      name: `Pelican Point wholesale 10% off ${SYNTHETIC}`,
      priceOrPercent: 'PERCENT',
      percent: 10,
      oneOfCompanies: [a.keys['company:pelican']!],
      oneOfProducts: [],
      inserted: at(-60),
      updated: at(-60),
    },
    {
      id: makeId(`${TENANT_A}:tier`, 'harborview-flower'),
      versionId: makeId(`${TENANT_A}:tier-version`, 'harborview-flower'),
      name: `Harborview Blue Dream flower flat ${SYNTHETIC}`,
      priceOrPercent: 'PRICE',
      price: 23,
      oneOfCompanies: [a.keys['company:harborview']!],
      oneOfProducts: [a.keys['product:bd-flower']!],
      inserted: at(-55),
      updated: at(-55),
    },
  )

  const b = buildTenant({
    id: TENANT_B,
    name: `Quillback Supply Co. ${SYNTHETIC}`,
    domain: 'quillback.synthetic.example',
    tokens: [[MOCK_TOKENS.tenantBFull, ALL_PERMISSIONS]],
    strains: [['Blue Dream', 'HYBRID']],
    categories: ['Flower'],
    products: [{ key: 'bd-flower', name: 'Blue Dream 7g Flower', sku: 'QB-BD-7', price: 45, strain: 'Blue Dream', category: 'Flower', unit: 'Each' }],
    stock: [['bd-flower', 50, 'main']],
    buyers: [{ key: 'osprey', name: `Osprey Bay Dispensary ${SYNTHETIC}`, category: 'Dispensary', licence: { number: 'SYN-C10-0000201', active: true, expiry: '2027-05-31T00:00:00Z' } }],
  })
  b.seq.order = 2000
  addOrder(b, { key: 'so-1', company: 'osprey', status: 'PENDING', day: 25, lines: [['bd-flower', 5, 45]] })

  return new Map<string, SeededTenant>([
    [a.id, a],
    [b.id, b],
  ])
}
