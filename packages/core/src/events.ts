/** One MCP tool invocation, as reported by a server to its host (for the audit table). */
export interface ToolCallEvent {
  server: 'distru' | 'workspace'
  tool: string
  principalId: string
  tenantId: string
  runId: string | null
  args: unknown
  ok: boolean
  error?: string
  /** Truncated result, for the audit trail. */
  result?: unknown
  latencyMs: number
  startedAt: string
}

export type ToolCallListener = (event: ToolCallEvent) => void | Promise<void>

/** Keeps audit rows small: long strings and big arrays are cut, with a marker. */
export function truncateForAudit(value: unknown, maxString = 2000, maxArray = 50): unknown {
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}...[truncated ${value.length - maxString} chars]` : value
  if (Array.isArray(value)) {
    const head = value.slice(0, maxArray).map((v) => truncateForAudit(v, maxString, maxArray))
    return value.length > maxArray ? [...head, `[truncated ${value.length - maxArray} items]`] : head
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateForAudit(v, maxString, maxArray)]))
  }
  return value
}
