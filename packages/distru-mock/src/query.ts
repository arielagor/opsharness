import { operation } from '@opsharness/distru-contract'

export class BadRequest extends Error {
  constructor(
    readonly pointer: (string | number)[],
    message: string,
  ) {
    super(message)
  }
}

export interface ParsedQuery {
  scalars: Map<string, string>
  arrays: Map<string, string[]>
  objects: Map<string, Map<string, string>>
  pageAfter?: string
}

const DATETIME_BOUND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Parses a query string the way Distru documents it, validated against the operation's
 * declared parameters:
 *  - array params must use bracketed keys (`ids[]=a`); a bare `ids=a` is a 400,
 *  - at most 200 values per array,
 *  - `page[after]` is the only page selector, and only together with nothing else,
 *  - unknown parameters are rejected rather than silently ignored.
 */
export function parseQuery(method: string, specPath: string, search: URLSearchParams): ParsedQuery {
  const params = new Map((operation(method, specPath).parameters ?? []).filter((p) => p.in === 'query').map((p) => [p.name, p]))
  const out: ParsedQuery = { scalars: new Map(), arrays: new Map(), objects: new Map() }
  let count = 0
  for (const [rawKey, value] of search.entries()) {
    count++
    if (rawKey === 'page[after]') {
      out.pageAfter = value
      continue
    }
    const arr = /^([a-z_]+)\[\]$/.exec(rawKey)
    const obj = /^([a-z_]+)\[([^\]]+)\]$/.exec(rawKey)
    if (arr) {
      const name = arr[1]!
      const p = params.get(name)
      if (!p) throw new BadRequest([name], `Unknown filter ${name}[]`)
      if (p.schema?.type !== 'array') throw new BadRequest([name], `${name} is not an array filter`)
      const list = out.arrays.get(name) ?? []
      list.push(value)
      if (list.length > 200) throw new BadRequest([name], `${name} accepts at most 200 values`)
      const allowed = p.schema.items?.enum
      if (allowed && !allowed.includes(value)) throw new BadRequest([name], `${value} is not a valid ${name} value`)
      out.arrays.set(name, list)
    } else if (obj) {
      const name = obj[1]!
      if (params.get(name)?.schema?.type !== 'object') throw new BadRequest([name], `Unknown filter ${rawKey}`)
      const m = out.objects.get(name) ?? new Map<string, string>()
      m.set(obj[2]!, value)
      out.objects.set(name, m)
    } else {
      const p = params.get(rawKey)
      if (!p || rawKey === 'page') throw new BadRequest([rawKey], `Unknown parameter ${rawKey}`)
      if (p.schema?.type === 'array') throw new BadRequest([rawKey], `${rawKey} is an array filter; repeat the bracketed key: ${rawKey}[]=value`)
      if (p.schema?.enum && !p.schema.enum.includes(value)) throw new BadRequest([rawKey], `${value} is not a valid ${rawKey} value`)
      if (p.schema?.type === 'boolean' && value !== 'true' && value !== 'false') throw new BadRequest([rawKey], `${rawKey} must be true or false`)
      out.scalars.set(rawKey, value)
    }
  }
  if (out.pageAfter !== undefined && count > 1) {
    throw new BadRequest(['page'], 'Pass next_page back exactly as given; it already carries the filters.')
  }
  return out
}

export interface DatetimeRange { min?: number; max?: number }

/** `min,max` inclusive, either side optional. */
export function parseRange(name: string, value: string | undefined): DatetimeRange | undefined {
  if (value === undefined) return undefined
  const parts = value.split(',')
  if (parts.length !== 2) throw new BadRequest([name], `${name} must be a comma-separated "after,before" range`)
  const [a, b] = parts as [string, string]
  if (a === '' && b === '') throw new BadRequest([name], `${name} needs at least one bound`)
  const bound = (s: string) => {
    if (s === '') return undefined
    if (!DATETIME_BOUND.test(s)) throw new BadRequest([name], `${s} is not an ISO8601 datetime`)
    return Date.parse(s)
  }
  const min = bound(a)
  const max = bound(b)
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }
}

export function inRange(iso: string, r: DatetimeRange | undefined): boolean {
  if (!r) return true
  const t = Date.parse(iso)
  return (r.min === undefined || t >= r.min) && (r.max === undefined || t <= r.max)
}
