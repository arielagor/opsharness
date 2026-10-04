/**
 * Distru's published OpenAPI 3.0 spec describes nullability in prose ("null when not set",
 * "null on the last page") but declares `nullable: true` on only a handful of properties.
 * Validating a real response strictly against the verbatim spec would reject a correct
 * `next_page: null`.
 *
 * This patch makes that prose machine-readable, mechanically and conservatively:
 *   - only OPTIONAL properties (never one listed in `required`),
 *   - only properties with an inline `type` (a `$ref` cannot carry a sibling keyword in 3.0),
 *   - only when the property's own description mentions `null`,
 *   - and never when it says "never null", "non-null" or "not null".
 *
 * It only ever loosens a schema (allows null where the prose says null happens). The
 * verbatim file stays untouched in openapi.json; this runs on a deep copy.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type SchemaObject = { [k: string]: Json }

const MENTIONS_NULL = /\bnull\b/i
const DENIES_NULL = /\b(never null|non-null|not null)\b/i

export interface PatchReport {
  patched: string[]
}

function isObject(v: Json | undefined): v is SchemaObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function patchNullable<T>(spec: T): { spec: T; report: PatchReport } {
  const copy = structuredClone(spec) as unknown as Json
  const patched: string[] = []

  const walk = (node: Json, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`))
      return
    }
    if (!isObject(node)) return
    const props = node['properties']
    if (isObject(props)) {
      const required = new Set(Array.isArray(node['required']) ? (node['required'] as string[]) : [])
      for (const [name, prop] of Object.entries(props)) {
        if (!isObject(prop)) continue
        const desc = typeof prop['description'] === 'string' ? prop['description'] : ''
        if (
          !required.has(name) &&
          typeof prop['type'] === 'string' &&
          prop['nullable'] !== true &&
          MENTIONS_NULL.test(desc) &&
          !DENIES_NULL.test(desc)
        ) {
          prop['nullable'] = true
          patched.push(`${path}.properties.${name}`)
        }
      }
    }
    for (const [key, child] of Object.entries(node)) walk(child, path ? `${path}.${key}` : key)
  }

  walk(copy, '')
  return { spec: copy as unknown as T, report: { patched } }
}
