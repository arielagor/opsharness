import { definePrincipal, type Principal } from './principal.js'

/**
 * SYNTHETIC demo principals for two fictional tenants. The harness seeds these into Postgres;
 * the MCP binaries and tests use them directly. Tenant ids match @opsharness/distru-mock.
 */
export const DEMO_TENANT_A = 'tenant-a'
export const DEMO_TENANT_B = 'tenant-b'

const READS = ['products:read', 'inventory:read', 'companies:read', 'orders:read', 'pricing:read', 'reports:read'] as const

export const DEMO_PRINCIPALS: readonly Principal[] = [
  definePrincipal({ id: 'agent-intake@tenant-a', tenantId: DEMO_TENANT_A, kind: 'agent', displayName: 'Intake agent', scopes: ['mail:read', 'sheets:read', 'products:read'] }),
  definePrincipal({ id: 'agent-erp@tenant-a', tenantId: DEMO_TENANT_A, kind: 'agent', displayName: 'ERP agent', scopes: [...READS, 'orders:propose'] }),
  definePrincipal({ id: 'agent-readonly@tenant-a', tenantId: DEMO_TENANT_A, kind: 'agent', displayName: 'Read-only agent', scopes: ['products:read', 'orders:read'] }),
  definePrincipal({ id: 'human-approver@tenant-a', tenantId: DEMO_TENANT_A, kind: 'human', displayName: 'Dana Ops (synthetic approver)', scopes: [...READS, 'orders:approve'] }),
  definePrincipal({ id: 'svc-applier@tenant-a', tenantId: DEMO_TENANT_A, kind: 'service', displayName: 'Plan applier', scopes: ['orders:read', 'orders:apply'] }),
  definePrincipal({ id: 'agent-erp@tenant-b', tenantId: DEMO_TENANT_B, kind: 'agent', displayName: 'ERP agent (tenant B)', scopes: [...READS, 'orders:propose'] }),
  definePrincipal({ id: 'human-approver@tenant-b', tenantId: DEMO_TENANT_B, kind: 'human', displayName: 'Lee Ops (synthetic approver)', scopes: [...READS, 'orders:approve'] }),
  definePrincipal({ id: 'svc-applier@tenant-b', tenantId: DEMO_TENANT_B, kind: 'service', displayName: 'Plan applier (tenant B)', scopes: ['orders:read', 'orders:apply'] }),
]

export function demoPrincipal(id: string): Principal {
  const p = DEMO_PRINCIPALS.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown demo principal ${id}`)
  return p
}
