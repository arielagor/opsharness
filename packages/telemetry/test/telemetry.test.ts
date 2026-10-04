import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { InMemorySpanExporter, initTelemetry, log, setLogSink, withRunContext, withSpan, type SpanRecord } from '../src/index.js'

describe('telemetry', () => {
  it('nests spans, tags them with the run id, and writes JSONL', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'otel-')), 'spans.jsonl')
    const mem = new InMemorySpanExporter()
    const t = initTelemetry({ serviceName: 'test', file, exporters: [mem] })
    await withRunContext({ runId: 'run-1', tenantId: 'tenant-a' }, () =>
      withSpan('graph.node intake', { 'graph.node': 'intake' }, async () => {
        await withSpan('mcp.tool search_products', { 'mcp.tool': 'search_products' }, async () => 1)
      }),
    )
    await expect(withSpan('mcp.tool broken', {}, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(mem.getFinishedSpans().length).toBe(3)
    await t.shutdown()

    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SpanRecord)
    expect(lines.map((l) => l.name)).toEqual(['mcp.tool search_products', 'graph.node intake', 'mcp.tool broken'])
    const [child, parent, broken] = lines as [SpanRecord, SpanRecord, SpanRecord]
    expect(child.parent_span_id).toBe(parent.span_id)
    expect(child.trace_id).toBe(parent.trace_id)
    expect(child.attributes['opsharness.run_id']).toBe('run-1')
    expect(broken.status).toBe('ERROR')
    expect(broken.status_message).toBe('boom')
  })

  it('structured logs carry run_id and the active trace', async () => {
    initTelemetry({ serviceName: 'test', exporters: [new InMemorySpanExporter()] })
    const lines: Record<string, unknown>[] = []
    setLogSink((l) => lines.push(l), 'debug')
    await withRunContext({ runId: 'run-2' }, () => withSpan('x', {}, async () => log.info('hello', { tool: 'get_order' })))
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'hello', run_id: 'run-2', tool: 'get_order' })
    expect(typeof lines[0]!['trace_id']).toBe('string')
  })
})
