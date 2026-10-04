import { defineConfig } from 'prisma/config'

// Local default matches docker-compose.yml (host port 5547). CI and other setups set DATABASE_URL.
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5547/opsharness'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL },
})
