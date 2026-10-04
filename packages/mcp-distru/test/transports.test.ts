import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEMO_PRINCIPALS } from '@opsharness/core'
import { buildDistruMcpServer, InMemoryPlanStore, mockConnection, serveMcpOverHttp } from '../src/index.js'

/** Built output is required here (the package's test script builds first). */
const STDIO_ENTRY = fileURLToPath(new URL('../dist/stdio.js', import.meta.url))

describe('stdio transport', () => {
  it('serves the tool list of the principal named in the environment', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_ENTRY],
      env: { ...(process.env as Record<string, string>), OPSHARNESS_PRINCIPAL: 'agent-readonly@tenant-a', OPSHARNESS_LOG_LEVEL: 'warn' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-test', version: '0.0.0' })
    await client.connect(transport)
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort()
      expect(tools).toEqual(['get_order', 'list_orders', 'search_products'])
      const r = await client.callTool({ name: 'search_products', arguments: { query: 'SD-VC' } })
      expect(JSON.stringify(r.structuredContent)).toContain('SD-VC-05')
    } finally {
      await client.close()
    }
  })
})

describe('streamable HTTP transport', () => {
  async function start() {
    const conn = mockConnection()
    const plans = new InMemoryPlanStore()
    return serveMcpOverHttp({
      authenticate: (token) => DEMO_PRINCIPALS.find((p) => `demo:${p.id}` === token),
      build: (principal) => buildDistruMcpServer({ principal, client: conn.clientFor(principal.tenantId), plans }),
    })
  }

  async function connectAs(url: string, principalId: string) {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer demo:${principalId}` } } })
    const client = new Client({ name: 'http-test', version: '0.0.0' })
    await client.connect(transport)
    return { client, transport }
  }

  it('lists tools per authenticated principal', async () => {
    const http = await start()
    try {
      const erp = await connectAs(http.url, 'agent-erp@tenant-a')
      const applier = await connectAs(http.url, 'svc-applier@tenant-a')
      expect((await erp.client.listTools()).tools.map((t) => t.name)).toContain('propose_order_change')
      expect((await erp.client.listTools()).tools.map((t) => t.name)).not.toContain('apply_plan')
      expect((await applier.client.listTools()).tools.map((t) => t.name).sort()).toEqual(['apply_plan', 'get_order', 'list_orders'])
      await erp.client.close()
      await applier.client.close()
    } finally {
      await http.close()
    }
  })

  it('rejects missing credentials, and a session id presented by another principal', async () => {
    const http = await start()
    try {
      const anon = await fetch(http.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(anon.status).toBe(401)
      const erp = await connectAs(http.url, 'agent-erp@tenant-a')
      const sessionId = erp.transport.sessionId!
      expect(sessionId).toBeTruthy()
      const hijack = await fetch(http.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer demo:agent-erp@tenant-b',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      })
      expect(hijack.status).toBe(403)
      await erp.client.close()
    } finally {
      await http.close()
    }
  })
})
