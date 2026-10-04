import type { components, paths } from './generated/distru.js'

export type { components, paths, operations } from './generated/distru.js'

type Schemas = components['schemas']

export type Product = Schemas['Product']
export type Products = Schemas['Products']
export type Inventory = Schemas['Inventory']
export type Inventories = Schemas['Inventories']
export type Company = Schemas['Company']
export type Companies = Schemas['Companies']
export type License = Schemas['License']
export type Order = Schemas['Order']
export type Orders = Schemas['Orders']
export type SalesOrderItem = Schemas['SalesOrderItem']
export type Invoice = Schemas['Invoice']
export type Invoices = Schemas['Invoices']
export type PriceTier = Schemas['PriceTier']
export type SalesOrderItemHistoryReport = Schemas['SalesOrderItemHistoryReport']
export type SalesOrderItemHistoryReportRow = Schemas['SalesOrderItemHistoryReportRow']
export type PdfResponse = Schemas['PdfResponse']
export type ErrorResponse = Schemas['ErrorResponse']
export type DistruError = Schemas['Error']

export type OrderUpsertRequest = NonNullable<
  paths['/public/v1/orders']['post']['requestBody']
>['content']['application/json']
export type OrderItemRequest = NonNullable<OrderUpsertRequest['items']>[number]

type QueryOf<P extends keyof paths> = paths[P] extends { get: { parameters: { query?: infer Q } } } ? NonNullable<Q> : never

export type ProductsQuery = QueryOf<'/public/v1/products'>
export type InventoryQuery = QueryOf<'/public/v1/inventory'>
export type CompaniesQuery = QueryOf<'/public/v1/companies'>
export type OrdersQuery = QueryOf<'/public/v1/orders'>
export type InvoicesQuery = QueryOf<'/public/v1/invoices'>
export type PriceTiersQuery = QueryOf<'/public/v1/price-tiers'>
export type SalesOrderItemHistoryQuery = QueryOf<'/public/v1/reports/sales-order-item-history'>
export type InventoryGrouping = NonNullable<InventoryQuery['groupings']>[number]
export type OrderStatus = Order['status']
