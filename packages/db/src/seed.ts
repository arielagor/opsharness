import { pathToFileURL } from 'node:url'
import { DEMO_PRINCIPALS, DEMO_TENANT_A, DEMO_TENANT_B, type Principal } from '@opsharness/core'
import { createDb, type Db } from './client.js'

/** SYNTHETIC tenants, named as in the Distru mock. Names are invented and refer to no real business. */
export const DEMO_TENANTS = [
  { id: DEMO_TENANT_A, name: 'Larkspur & Vine Distribution [SYNTHETIC]' },
  { id: DEMO_TENANT_B, name: 'Quillback Supply Co. [SYNTHETIC]' },
]

/** Idempotent: upserts tenants and principals and makes each principal's grants match exactly. */
export async function seedPrincipals(db: Db, tenants = DEMO_TENANTS, principals: readonly Principal[] = DEMO_PRINCIPALS) {
  for (const t of tenants) await db.tenant.upsert({ where: { id: t.id }, create: t, update: { name: t.name } })
  for (const p of principals) {
    await db.$transaction([
      db.principal.upsert({
        where: { id: p.id },
        create: { id: p.id, tenantId: p.tenantId, kind: p.kind, displayName: p.displayName },
        update: { tenantId: p.tenantId, kind: p.kind, displayName: p.displayName },
      }),
      db.grant.deleteMany({ where: { principalId: p.id } }),
      db.grant.createMany({ data: p.scopes.map((scope) => ({ principalId: p.id, scope })) }),
    ])
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const db = createDb()
  await seedPrincipals(db)
  await db.$disconnect()
  process.stderr.write(`seeded ${DEMO_TENANTS.length} tenants and ${DEMO_PRINCIPALS.length} principals (synthetic)\n`)
}
