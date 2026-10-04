import type { DistruError } from '@opsharness/distru-contract'

/**
 * The ONE parser for Distru's error envelope: `{ "errors": [ { "message", "pointer" } ] }`.
 * Every endpoint uses this shape. Deprecated `section` / `context` fields are dropped.
 * A body that is not the envelope (a proxy page, an empty 5xx) becomes a single `["base"]` error.
 */
export function parseErrorEnvelope(body: unknown): DistruError[] {
  if (typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors)) {
    const out: DistruError[] = []
    for (const e of (body as { errors: unknown[] }).errors) {
      if (typeof e !== 'object' || e === null) continue
      const message = (e as { message?: unknown }).message
      const pointer = (e as { pointer?: unknown }).pointer
      out.push({
        message: typeof message === 'string' ? message : 'Unknown error',
        pointer: Array.isArray(pointer) ? pointer.filter((p) => typeof p === 'string' || typeof p === 'number') : ['base'],
      })
    }
    if (out.length > 0) return out
  }
  return [{ message: 'Response body was not a Distru error envelope', pointer: ['base'] }]
}

/** `["items", 0, "quantity"]` → `items[0].quantity`; `["base"]` → `(request)`. */
export function pointerToString(pointer: readonly unknown[]): string {
  if (pointer.length === 0 || (pointer.length === 1 && pointer[0] === 'base')) return '(request)'
  return pointer
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
    .join('')
}

/** A non-2xx response from Distru, carrying the parsed envelope. */
export class DistruApiError extends Error {
  override readonly name = 'DistruApiError'

  constructor(
    readonly status: number,
    readonly errors: DistruError[],
    readonly method: string,
    readonly path: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`${method} ${path} -> ${status}: ${errors.map((e) => `${pointerToString(e.pointer)}: ${e.message}`).join('; ')}`)
  }

  /** 404 means "no such record for this account": an unknown id OR another account's id. */
  get isNotFound(): boolean {
    return this.status === 404
  }

  /** Only 429 is worth retrying, and only after Retry-After. 400/401/403/404 never are. */
  get isRetryable(): boolean {
    return this.status === 429
  }
}

/** A mistake caught before any request is sent (for example more than 200 ids). */
export class DistruClientError extends Error {
  override readonly name = 'DistruClientError'
}
