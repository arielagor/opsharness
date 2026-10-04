import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { context, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base'

export { InMemorySpanExporter, type ReadableSpan }

// ---------- run context -------------------------------------------------------------------

export interface RunContext {
  runId: string
  tenantId?: string
}

const runStore = new AsyncLocalStorage<RunContext>()

export function withRunContext<T>(ctx: RunContext, fn: () => T): T {
  return runStore.run(ctx, fn)
}

export function currentRun(): RunContext | undefined {
  return runStore.getStore()
}

// ---------- JSONL exporter -----------------------------------------------------------------

export interface SpanRecord {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  start: string
  end: string
  duration_ms: number
  status: 'UNSET' | 'OK' | 'ERROR'
  status_message?: string
  attributes: Attributes
  events: { name: string; attributes?: Attributes }[]
  service: string
}

const hrToMs = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6

export function toSpanRecord(s: ReadableSpan): SpanRecord {
  const parent = (s as unknown as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId
  return {
    trace_id: s.spanContext().traceId,
    span_id: s.spanContext().spanId,
    parent_span_id: parent ?? null,
    name: s.name,
    start: new Date(hrToMs(s.startTime)).toISOString(),
    end: new Date(hrToMs(s.endTime)).toISOString(),
    duration_ms: Math.round(hrToMs(s.duration) * 1000) / 1000,
    status: s.status.code === SpanStatusCode.ERROR ? 'ERROR' : s.status.code === SpanStatusCode.OK ? 'OK' : 'UNSET',
    ...(s.status.message ? { status_message: s.status.message } : {}),
    attributes: s.attributes,
    events: s.events.map((e) => ({ name: e.name, ...(e.attributes ? { attributes: e.attributes } : {}) })),
    service: String(s.resource.attributes['service.name'] ?? 'unknown'),
  }
}

/** One JSON object per finished span, appended to a file. Synchronous so nothing is lost on exit. */
export class JsonlFileSpanExporter implements SpanExporter {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
  }
  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    try {
      appendFileSync(this.file, spans.map((s) => JSON.stringify(toSpanRecord(s))).join('\n') + '\n')
      done({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error: error as Error })
    }
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

// ---------- setup -------------------------------------------------------------------------

export interface Telemetry {
  provider: BasicTracerProvider
  exporters: SpanExporter[]
  shutdown(): Promise<void>
}

let active: Telemetry | undefined
let contextManagerSet = false

/**
 * Installs a global tracer provider. `file` adds a JSONL exporter; `exporters` adds others
 * (tests pass an InMemorySpanExporter). Calling it again replaces the previous provider.
 */
export function initTelemetry(opts: { serviceName: string; file?: string; exporters?: SpanExporter[] }): Telemetry {
  if (!contextManagerSet) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    contextManagerSet = true
  }
  const exporters = [...(opts.exporters ?? []), ...(opts.file ? [new JsonlFileSpanExporter(opts.file)] : [])]
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': opts.serviceName }),
    spanProcessors: exporters.map((e) => new SimpleSpanProcessor(e)),
  })
  trace.disable()
  trace.setGlobalTracerProvider(provider)
  active = { provider, exporters, shutdown: () => provider.shutdown() }
  return active
}

export function activeTelemetry(): Telemetry | undefined {
  return active
}

const tracer = () => trace.getTracer('opsharness')

/**
 * Runs `fn` inside an active span. The run id (if any) is attached to every span so a trace
 * can be joined to the runs and tool_calls tables.
 */
export interface SpanOptions {
  /** Exceptions used for control flow (e.g. a graph interrupt): recorded as an event, not an error. */
  expected?: (error: unknown) => boolean
}

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, opts: SpanOptions = {}): Promise<T> {
  const run = currentRun()
  const attrs: Attributes = { ...attributes, ...(run ? { 'opsharness.run_id': run.runId } : {}), ...(run?.tenantId ? { 'opsharness.tenant_id': run.tenantId } : {}) }
  return tracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const out = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return out
    } catch (error) {
      if (opts.expected?.(error)) {
        span.addEvent('control_flow', { 'exception.type': (error as Error).name ?? 'unknown' })
        span.setStatus({ code: SpanStatusCode.OK })
        throw error
      }
      span.recordException(error as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
      throw error
    } finally {
      span.end()
    }
  })
}

export function currentTraceId(): string | undefined {
  const s = trace.getActiveSpan()
  return s ? s.spanContext().traceId : undefined
}

// ---------- structured logs ---------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSink = (line: Record<string, unknown>) => void

/** stderr by default: stdout belongs to the MCP stdio transport. */
let sink: LogSink = (line) => process.stderr.write(JSON.stringify(line) + '\n')
let minLevel: LogLevel = (process.env['OPSHARNESS_LOG_LEVEL'] as LogLevel | undefined) ?? 'info'
const order: LogLevel[] = ['debug', 'info', 'warn', 'error']

export function setLogSink(s: LogSink, level: LogLevel = minLevel): void {
  sink = s
  minLevel = level
}

function emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  if (order.indexOf(level) < order.indexOf(minLevel)) return
  const run = currentRun()
  const span = trace.getActiveSpan()?.spanContext()
  sink({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(run ? { run_id: run.runId } : {}),
    ...(run?.tenantId ? { tenant_id: run.tenantId } : {}),
    ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}),
    ...fields,
  })
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
}
