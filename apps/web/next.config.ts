import type { NextConfig } from 'next'

const config: NextConfig = {
  // Prisma's driver adapter and pg stay as plain Node modules on the server.
  serverExternalPackages: ['pg', '@prisma/adapter-pg', '@prisma/client'],
  poweredByHeader: false,
}

export default config
