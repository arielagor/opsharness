import 'server-only'
import { createDb, PrismaPlanStore, RunStore, type Db } from '@opsharness/db'
import { contextFor, execute, makeYoga, type GqlContext, type Yoga } from './schema'

/**
 * The console runs as ONE configured human principal (no login in this sample). Its tenant
 * scopes every query. Default: the SYNTHETIC approver of tenant-a.
 */
export const VIEWER_ID = process.env['OPSHARNESS_CONSOLE_PRINCIPAL'] ?? 'human-approver@tenant-a'

const g = globalThis as unknown as { __opsharnessDb?: Db; __opsharnessYoga?: Yoga }

export async function context(): Promise<GqlContext> {
  // One pool per server process, also across dev hot reloads.
  const db = (g.__opsharnessDb ??= createDb())
  return contextFor(db, new RunStore(db), new PrismaPlanStore(db), VIEWER_ID)
}

export const yoga = (g.__opsharnessYoga ??= makeYoga(context))

/**
 * Pages read through the same yoga handler that serves /api/graphql, called in process so a
 * server component does not make an HTTP request to its own server.
 */
export function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return execute<T>(yoga, query, variables)
}
