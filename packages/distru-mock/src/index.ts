import { createServer, type Server } from 'node:http'
import { createMockDistru, type MockDistru, type MockDistruOptions } from './handler.js'

export { createMockDistru, ordersFingerprint, type MockDistru, type MockDistruOptions } from './handler.js'
export { MOCK_TOKENS, SYNTHETIC, TENANT_A, TENANT_B, seedTenants, type SeededTenant } from './seed.js'
export { ALL_PERMISSIONS, type Permission, type Tenant } from './model.js'
export { validateRequest, validateResponse, type SchemaViolation } from './validate.js'

/** Serves the mock over node:http. Resolves once listening; `close()` stops it. */
export async function serveMockDistru(port = 0, options: MockDistruOptions = {}): Promise<{ mock: MockDistru; server: Server; url: string; close: () => Promise<void> }> {
  const mock = createMockDistru(options)
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const host = req.headers.host ?? `127.0.0.1:${port}`
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const body = chunks.length && req.method !== 'GET' ? Buffer.concat(chunks) : undefined
      const response = await mock.fetch(new Request(`http://${host}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) }))
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errors: [{ message: `mock crashed: ${(e as Error).message}`, pointer: ['base'] }] }))
    }
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  const actual = typeof address === 'object' && address ? address.port : port
  return {
    mock,
    server,
    url: `http://127.0.0.1:${actual}/public/v1`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
