import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.js'

/** Matches docker-compose.yml (host port 5547). Anything else sets DATABASE_URL. */
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5547/opsharness'

export function databaseUrl(): string {
  return process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL
}

export type Db = PrismaClient

export function createDb(url: string = databaseUrl()): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
}
