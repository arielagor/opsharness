import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'
import { distruSpec, requestBodySchema, responseSchema } from '@opsharness/distru-contract'

// ajv-formats ships CJS with a default export; normalise across interop modes.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => Ajv

const SPEC_ID = 'distru'
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

let ajv: Ajv | undefined
const cache = new Map<string, ValidateFunction>()

function instance(): Ajv {
  if (!ajv) {
    // strict:false because the spec carries OpenAPI-only keywords (example, nullable on $ref
    // siblings, and so on). `nullable` itself is understood by ajv.
    ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true })
    addFormats(ajv)
    // Non-standard formats used by Distru's spec.
    ajv.addFormat('decimal', /^-?\d+(\.\d+)?$/)
    ajv.addFormat('datetime', DATETIME)
    ajv.addFormat('binary', true)
    ajv.addSchema(distruSpec() as object, SPEC_ID)
  }
  return ajv
}

/** Rewrites local `#/...` refs so they resolve inside the registered spec document. */
function anchor(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(anchor)
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(schema)) out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `${SPEC_ID}${v}` : anchor(v)
    return out
  }
  return schema
}

function compile(key: string, schema: unknown): ValidateFunction {
  let fn = cache.get(key)
  if (!fn) {
    fn = instance().compile(anchor(schema) as object)
    cache.set(key, fn)
  }
  return fn
}

export interface SchemaViolation {
  pointer: (string | number)[]
  message: string
}

function toViolations(errors: ErrorObject[] | null | undefined): SchemaViolation[] {
  return (errors ?? []).map((e) => {
    const pointer: (string | number)[] = e.instancePath
      .split('/')
      .slice(1)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : p.replace(/~1/g, '/').replace(/~0/g, '~')))
    if (e.keyword === 'required') pointer.push((e.params as { missingProperty: string }).missingProperty)
    return { pointer: pointer.length ? pointer : ['base'], message: e.message ?? 'is invalid' }
  })
}

/**
 * Validates a request body. For POST /orders the spec marks OrderItemRequest.price_base and
 * .quantity as required, yet the endpoint's own documentation says an entry of just
 * `{ "id": "..." }` keeps an existing line unchanged. The documented behaviour wins: item-level
 * `required` is enforced in code for NEW lines only (see upsert.ts). BUILD-LOG.md records this.
 */
export function validateRequest(method: string, path: string, body: unknown): SchemaViolation[] {
  let schema = requestBodySchema(method, path)
  if (!schema) return []
  if (method === 'post' && path === '/public/v1/orders') schema = orderUpsertSchemaWithoutItemRequired()
  const fn = compile(`req:${method}:${path}`, schema)
  // "A field sent as null is cleared": null is legal on any field in a request; whether it is
  // allowed for a particular field (required ones reject it) is decided by the handler.
  const withoutNulls = stripNulls(body)
  return fn(withoutNulls) ? [] : toViolations(fn.errors)
}

function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = stripNulls(x)
    return out
  }
  return v
}

function orderUpsertSchemaWithoutItemRequired(): unknown {
  const spec = distruSpec() as unknown as { components: { schemas: Record<string, { required?: string[] }> } }
  const original = spec.components.schemas['OrderItemRequest']!
  const relaxed = { ...original, required: [] }
  const top = requestBodySchema('post', '/public/v1/orders') as { $ref?: string }
  const topSchema = top.$ref ? spec.components.schemas[top.$ref.split('/').pop()!] : top
  const t = structuredClone(topSchema) as { properties: { items: { items: unknown } } }
  t.properties.items.items = relaxed
  return t
}

/** Validates a response body against the spec's schema for that operation and status. */
export function validateResponse(method: string, path: string, status: number, body: unknown): SchemaViolation[] {
  const schema = responseSchema(method, path, status)
  if (!schema) return [{ pointer: ['base'], message: `spec declares no ${status} response for ${method.toUpperCase()} ${path}` }]
  const fn = compile(`res:${method}:${path}:${status}`, schema)
  return fn(body) ? [] : toViolations(fn.errors)
}
