import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { patchNullable, type PatchReport } from './patch.js'

export { patchNullable, type PatchReport } from './patch.js'
export type * from './types.js'

/** sha256 of the verbatim openapi.json copied from Distru's published reference. */
export const SPEC_SHA256 = '421cc4d0838bc199d85746a336da92eed7a1e5d90378605f71a575e0294e4dc8'

/** The operations this work sample implements, in client, mock and contract tests. */
export const SUBSET = [
  ['get', '/public/v1/products'],
  ['get', '/public/v1/products/{id}'],
  ['get', '/public/v1/inventory'],
  ['get', '/public/v1/companies'],
  ['get', '/public/v1/companies/{id}'],
  ['get', '/public/v1/orders'],
  ['get', '/public/v1/orders/{id}'],
  ['post', '/public/v1/orders'],
  ['get', '/public/v1/invoices'],
  ['get', '/public/v1/price-tiers'],
  ['get', '/public/v1/reports/sales-order-item-history'],
  ['post', '/public/v1/orders/{id}/pdf'],
] as const

export type SubsetOperation = (typeof SUBSET)[number]

export interface OpenApiDocument {
  openapi: string
  paths: Record<string, Record<string, OpenApiOperation>>
  components: {
    schemas: Record<string, unknown>
    requestBodies?: Record<string, { content: Record<string, { schema: unknown }>; required?: boolean }>
  }
}

export interface OpenApiParameter {
  in: 'query' | 'path' | 'header'
  name: string
  required?: boolean
  schema?: { type?: string; items?: { type?: string; enum?: string[] }; enum?: string[] }
}

export interface OpenApiOperation {
  operationId?: string
  summary?: string
  parameters?: OpenApiParameter[]
  requestBody?: { $ref?: string; content?: Record<string, { schema: unknown }> }
  responses: Record<string, { description?: string; content?: Record<string, { schema: unknown }> }>
}

const specUrl = new URL('../openapi.json', import.meta.url)

let rawCache: { text: string; doc: OpenApiDocument } | undefined
let patchedCache: { doc: OpenApiDocument; report: PatchReport } | undefined

function raw(): { text: string; doc: OpenApiDocument } {
  if (!rawCache) {
    const text = readFileSync(specUrl, 'utf8')
    rawCache = { text, doc: JSON.parse(text) as OpenApiDocument }
  }
  return rawCache
}

/** The verbatim published spec. */
export function verbatimSpec(): OpenApiDocument {
  return raw().doc
}

export function verbatimSpecSha256(): string {
  return createHash('sha256').update(raw().text).digest('hex')
}

/** The spec with prose-documented nulls made machine-readable (see patch.ts). */
export function distruSpec(): OpenApiDocument {
  if (!patchedCache) {
    const { spec, report } = patchNullable(raw().doc)
    patchedCache = { doc: spec, report }
  }
  return patchedCache.doc
}

export function nullabilityPatchReport(): PatchReport {
  distruSpec()
  return patchedCache!.report
}

export function operation(method: string, path: string): OpenApiOperation {
  const op = distruSpec().paths[path]?.[method]
  if (!op) throw new Error(`No ${method.toUpperCase()} ${path} in the Distru spec`)
  return op
}

/** The JSON schema of an operation's request body, resolving a components/requestBodies $ref. */
export function requestBodySchema(method: string, path: string): unknown {
  const op = operation(method, path)
  let body = op.requestBody
  if (body?.$ref) {
    const name = body.$ref.split('/').pop()!
    body = distruSpec().components.requestBodies?.[name]
  }
  const content = body?.content
  if (!content) return undefined
  const first = Object.values(content)[0]
  return first?.schema
}

/** The JSON schema for a response status of an operation. */
export function responseSchema(method: string, path: string, status: number | string): unknown {
  const res = operation(method, path).responses[String(status)]
  const first = res?.content ? Object.values(res.content)[0] : undefined
  return first?.schema
}
