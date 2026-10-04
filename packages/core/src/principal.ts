/**
 * Who is calling. A principal belongs to exactly one tenant and holds a set of scopes.
 * The tenant is never a tool argument: every MCP server is built FOR a principal, and the
 * tenant comes from here.
 */

export const SCOPES = [
  'products:read',
  'inventory:read',
  'companies:read',
  'orders:read',
  'pricing:read',
  'reports:read',
  /** Create a write PLAN. Never writes to Distru. */
  'orders:propose',
  /** Execute an APPROVED plan. Never granted to a model-driven principal. */
  'orders:apply',
  /** Record a human approval or rejection. Humans only. */
  'orders:approve',
  'mail:read',
  'sheets:read',
] as const

export type Scope = (typeof SCOPES)[number]

export type PrincipalKind = 'agent' | 'human' | 'service'

export interface Principal {
  id: string
  tenantId: string
  kind: PrincipalKind
  displayName: string
  scopes: readonly Scope[]
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes(scope)
}

export class ScopeError extends Error {
  constructor(
    readonly principalId: string,
    readonly scope: Scope,
  ) {
    super(`Principal ${principalId} lacks scope ${scope}`)
  }
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!hasScope(p, scope)) throw new ScopeError(p.id, scope)
}

/**
 * Scopes that must never be held by a model-driven (agent) principal. Enforced when a
 * principal is constructed, so a misconfigured grant fails loudly instead of quietly
 * exposing a write tool to an LLM.
 */
export const HUMAN_OR_SERVICE_ONLY: readonly Scope[] = ['orders:apply', 'orders:approve']

export function definePrincipal(p: Principal): Principal {
  if (!p.tenantId) throw new Error(`Principal ${p.id} has no tenant`)
  for (const s of p.scopes) if (!(SCOPES as readonly string[]).includes(s)) throw new Error(`Unknown scope ${s}`)
  if (p.kind === 'agent') {
    const bad = p.scopes.filter((s) => HUMAN_OR_SERVICE_ONLY.includes(s))
    if (bad.length) throw new Error(`Agent principal ${p.id} must not hold ${bad.join(', ')}`)
  }
  return Object.freeze({ ...p, scopes: Object.freeze([...p.scopes]) })
}
