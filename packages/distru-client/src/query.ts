import { DistruClientError } from './errors.js'

export const MAX_ARRAY_FILTER_VALUES = 200

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | readonly QueryScalar[] | Readonly<Record<string, QueryScalar>> | undefined | null

/**
 * Builds a Distru query string.
 *  - Arrays repeat a bracketed key: `ids[]=a&ids[]=b` (a bare `ids=a` is a 400). Max 200 values.
 *  - Objects (only `custom_data`) become `custom_data[<id>]=<value>`.
 *  - `page` is refused: page selectors come only from a response's `next_page`.
 */
export function buildQuery(params: Readonly<Record<string, QueryValue>> = {}): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (key === 'page') {
      throw new DistruClientError('Never build a page selector; follow next_page from the previous response.')
    }
    const k = encodeURIComponent(key)
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_FILTER_VALUES) {
        throw new DistruClientError(`${key}[] accepts at most ${MAX_ARRAY_FILTER_VALUES} values; got ${value.length}. Split the request.`)
      }
      for (const v of value) parts.push(`${k}[]=${encodeURIComponent(String(v))}`)
    } else if (typeof value === 'object') {
      for (const [sub, v] of Object.entries(value as Record<string, QueryScalar>)) {
        parts.push(`${k}[${encodeURIComponent(sub)}]=${encodeURIComponent(String(v))}`)
      }
    } else {
      parts.push(`${k}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.join('&')
}

function iso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString()
}

/**
 * Distru datetime filters are inclusive comma ranges. Either side may be open:
 * `datetimeRange({ from })` → `<from>,` (on or after), `datetimeRange({ to })` → `,<to>`.
 */
export function datetimeRange(range: { from?: Date | string; to?: Date | string }): string {
  if (range.from === undefined && range.to === undefined) {
    throw new DistruClientError('A datetime range needs at least one bound.')
  }
  return `${range.from === undefined ? '' : iso(range.from)},${range.to === undefined ? '' : iso(range.to)}`
}

/** Splits a long id list into chunks that respect the 200-value cap. */
export function chunkIds<T>(ids: readonly T[], size = MAX_ARRAY_FILTER_VALUES): T[][] {
  const out: T[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
