import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Principal } from '@opsharness/core'

export interface HttpMcpOptions {
  port?: number
  /** Maps a bearer token to a principal; undefined means 401. */
  authenticate: (token: string) => Principal | undefined
  /** Builds a fresh MCP server for the authenticated principal (one per session). */
  build: (principal: Principal) => McpServer
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

/**
 * Streamable HTTP, stateful sessions. The principal is fixed when the session is initialised
 * and every later request on that session must authenticate as the same principal: a session
 * id alone grants nothing. Binds to 127.0.0.1.
 */
export async function serveMcpOverHttp(opts: HttpMcpOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; principalId: string; mcp: McpServer }>()

  const server = createServer(async (req, res) => {
    try {
      if ((req.url ?? '').split('?')[0] !== '/mcp') return json(res, 404, { error: 'not found' })
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      const principal = token ? opts.authenticate(token) : undefined
      if (!principal) return json(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null })

      let body: unknown
      if (req.method === 'POST') {
        try {
          body = await readJson(req)
        } catch {
          return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
        }
      }

      const sid = req.headers['mcp-session-id']
      if (typeof sid === 'string') {
        const s = sessions.get(sid)
        if (!s) return json(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })
        if (s.principalId !== principal.id) return json(res, 403, { jsonrpc: '2.0', error: { code: -32003, message: 'Session belongs to another principal' }, id: null })
        return await s.transport.handleRequest(req, res, body)
      }

      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No session: send an initialize request first' }, id: null })
      }
      const mcp = opts.build(principal)
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, principalId: principal.id, mcp })
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null })
    }
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  return {
    server,
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      for (const s of sessions.values()) await s.mcp.close()
      sessions.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    },
  }
}
