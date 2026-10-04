import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { demoPrincipal } from '@opsharness/core'
import { buildWorkspaceMcpServer, parseCsv, TenantWorkspace } from '../src/index.js'

async function connect(principalId: string) {
  const [c, s] = InMemoryTransport.createLinkedPair()
  await buildWorkspaceMcpServer({ principal: demoPrincipal(principalId) }).connect(s)
  const client = new Client({ name: 't', version: '0' })
  await client.connect(c)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { isError: Boolean(r.isError), text: (r.content as { text: string }[])[0]!.text, data: (r.structuredContent ?? {}) as Record<string, unknown> }
  }
  return { client, call }
}

describe('workspace fixtures', () => {
  it('parses quoted CSV cells', () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\r\n')).toEqual([
      ['a', 'b'],
      ['1', 'x, "y"'],
    ])
  })

  it('every tenant-a fixture email parses and is labelled synthetic', async () => {
    const ws = new TenantWorkspace('tenant-a')
    const list = await ws.listEmails()
    expect(list.length).toBe(8)
    for (const m of list) expect((await ws.readEmail(m.message_id))!.body).toContain('[SYNTHETIC FIXTURE')
  })
})

describe('workspace MCP server', () => {
  it('lists tools by scope: the ERP agent has no mail or sheet access', async () => {
    const intake = await connect('agent-intake@tenant-a')
    expect((await intake.client.listTools()).tools.map((t) => t.name).sort()).toEqual(['list_inbox', 'list_sheets', 'read_email', 'read_sheet'])
    const erp = await connect('agent-erp@tenant-a')
    expect((await erp.client.listTools()).tools).toEqual([])
  })

  it('frames email bodies as untrusted, defangs a fake closing tag, and flags the injection', async () => {
    const { call } = await connect('agent-intake@tenant-a')
    const r = await call('read_email', { message_id: '006-juniper-prompt-injection' })
    expect(r.data['injection_suspected']).toBe(true)
    expect(r.text.match(/<\/untrusted_content>/g)?.length).toBe(1)
    expect(r.text.trimEnd().endsWith('</untrusted_content>')).toBe(true)
    const clean = await call('read_email', { message_id: '001-harborview-new-order' })
    expect(clean.data['injection_suspected']).toBe(false)
  })

  it('reads the order sheet', async () => {
    const { call } = await connect('agent-intake@tenant-a')
    const r = await call('read_sheet', { sheet_id: 'pelican-weekly-2026-10-01' })
    expect((r.data['rows'] as { sku: string }[]).map((x) => x.sku)).toEqual(['GDP-FL-35', 'HB-VD-05'])
  })

  it("is tenant-scoped and rejects path tricks", async () => {
    const a = await connect('agent-intake@tenant-a')
    for (const id of ['../tenant-b/mail/001-osprey-order', '..\\tenant-b\\mail\\001-osprey-order', '001-osprey-order']) {
      const r = await a.call('read_email', { message_id: id })
      expect(r.isError).toBe(true)
      expect(r.text).toBe('No such message in this inbox.')
    }
  })
})

describe('stdio transport', () => {
  it('serves over stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/stdio.js', import.meta.url))],
      env: { ...(process.env as Record<string, string>), OPSHARNESS_LOG_LEVEL: 'warn' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 's', version: '0' })
    await client.connect(transport)
    try {
      expect((await client.listTools()).tools.length).toBe(4)
    } finally {
      await client.close()
    }
  })
})
