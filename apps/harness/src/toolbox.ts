import { trace } from '@opentelemetry/api'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Principal } from '@opsharness/core'
import type { AuditRow } from '@opsharness/db'
import { withSpan } from '@opsharness/telemetry'

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolResult {
  isError: boolean
  text: string
  data: Record<string, unknown>
}

export interface CallMeta {
  node: string
  modelTurnId?: string
  inputTokens?: number
  outputTokens?: number
}

export type AuditSink = (row: AuditRow) => Promise<unknown>

/**
 * An MCP client session for ONE principal against ONE server, plus the audit hook. The tool list
 * is whatever the server listed for that principal; `call` forwards anything (including a name
 * that was never listed) so the server, not the harness, is what refuses.
 */
export interface Toolbox {
  principal: Principal
  server: 'distru' | 'workspace'
  tools: ToolSpec[]
  call(name: string, args: Record<string, unknown>, meta: CallMeta): Promise<ToolResult>
  close(): Promise<void>
}

export async function openToolbox(opts: { server: McpServer; serverName: 'distru' | 'workspace'; principal: Principal; runId: string; audit: AuditSink }): Promise<Toolbox> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await opts.server.connect(serverSide)
  const client = new Client({ name: `opsharness-harness/${opts.principal.id}`, version: '0.1.0' })
  await client.connect(clientSide)
  const listed = (await client.listTools()).tools
  const tools: ToolSpec[] = listed.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> }))

  return {
    principal: opts.principal,
    server: opts.serverName,
    tools,
    async call(name, args, meta) {
      const startedAt = new Date()
      const t0 = performance.now()
      const result = await withSpan(
        `mcp.call ${name}`,
        { 'mcp.server': opts.serverName, 'mcp.tool': name, 'opsharness.principal_id': opts.principal.id, 'opsharness.node': meta.node },
        async (span): Promise<ToolResult> => {
          let r: ToolResult
          try {
            const out = await client.callTool({ name, arguments: args })
            const text = ((out.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? '').join('\n')
            r = { isError: Boolean(out.isError), text, data: (out.structuredContent ?? {}) as Record<string, unknown> }
          } catch (e) {
            // e.g. JSON-RPC errors such as an unknown tool or invalid arguments.
            r = { isError: true, text: (e as Error).message, data: {} }
          }
          span.setAttribute('mcp.tool.ok', !r.isError)
          if (r.isError) span.setAttribute('mcp.tool.error', r.text.slice(0, 500))
          return r
        },
      )
      const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000
      await opts.audit({
        runId: opts.runId,
        tenantId: opts.principal.tenantId,
        principalId: opts.principal.id,
        server: opts.serverName,
        tool: name,
        node: meta.node,
        args,
        ok: !result.isError,
        ...(result.isError ? { error: result.text.slice(0, 2000) } : { result: result.data }),
        latencyMs,
        ...(meta.inputTokens !== undefined ? { inputTokens: meta.inputTokens } : {}),
        ...(meta.outputTokens !== undefined ? { outputTokens: meta.outputTokens } : {}),
        ...(meta.modelTurnId ? { modelTurnId: meta.modelTurnId } : {}),
        ...(traceIdNow() ? { traceId: traceIdNow()! } : {}),
        startedAt: startedAt.toISOString(),
      })
      return result
    },
    async close() {
      await client.close()
      await opts.server.close()
    },
  }
}

export function traceIdNow(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId
}
