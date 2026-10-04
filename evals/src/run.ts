#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createDb, seedPrincipals } from '@opsharness/db'
import { TENANT_A } from '@opsharness/distru-mock'
import { anthropicModels, claudeCliModels, cliUsage, Harness, scriptedModels, type ModelChoice } from '@opsharness/harness'
import { mockConnection } from '@opsharness/mcp-distru'
import { initTelemetry, InMemorySpanExporter, setLogSink } from '@opsharness/telemetry'
import { advanceClock, clock, resetClock, SCENARIOS, type CheckResult, type EvalCtx, type Scenario } from './scenarios.js'

/**
 * Runs the scenarios against the in-process Distru mock (SYNTHETIC data) and real Postgres.
 *   node dist/run.js                 deterministic: scripted model, exits 1 on any failed check
 *   node dist/run.js --live          live model (OPSHARNESS_MODEL + ANTHROPIC_API_KEY, or
 *                                    OPSHARNESS_LEAN_CLAUDE); records the result, never fails the build
 *   --only S03,S07   --budget-usd 5   --out FILE
 */
const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    only: { type: 'string' },
    'budget-usd': { type: 'string', default: '5' },
    out: { type: 'string' },
  },
})

const HERE = dirname(fileURLToPath(import.meta.url))
const out = (s: string) => process.stdout.write(`${s}\n`)
setLogSink((line) => process.stderr.write(`${JSON.stringify(line)}\n`), 'warn')
const spans = new InMemorySpanExporter()
const telemetry = initTelemetry({ serviceName: 'opsharness-evals', exporters: [spans], file: join(HERE, '..', '..', '.otel', values.live ? 'evals-live.jsonl' : 'evals.jsonl') })

interface ScenarioResult {
  id: string
  title: string
  pass: boolean
  skipped?: string
  error?: string
  checks: CheckResult[]
  metrics: { runs: number; model_turns: number; input_tokens: number; output_tokens: number; mcp_calls: number; distru_writes: number; graph_node_spans: number; mcp_call_spans: number; duration_ms: number }
}

async function liveChoice(): Promise<ModelChoice> {
  const m = (await anthropicModels()) ?? (await claudeCliModels())
  if (!m) throw new Error('--live needs OPSHARNESS_MODEL plus ANTHROPIC_API_KEY (or OPSHARNESS_LEAN_CLAUDE)')
  return m
}

async function runScenario(s: Scenario, choice: ModelChoice): Promise<ScenarioResult> {
  resetClock()
  spans.reset()
  const sleeps: number[] = []
  const conn = mockConnection({ now: () => clock, sleep: async (ms) => void (sleeps.push(ms), advanceClock(ms)) })
  const tenant = conn.mock!.tenants.get(TENANT_A)!
  const open = () => Harness.create({ connection: conn, model: choice.model, modelName: choice.modelName, mode: choice.mode, now: () => new Date(clock) })
  const ctx: EvalCtx = {
    live: values.live,
    conn,
    tenant,
    harness: await open(),
    sleeps,
    runIds: [],
    async restart() {
      await ctx.harness.close()
      ctx.harness = await open()
      return ctx.harness
    },
  }
  s.setup?.(ctx)
  const t0 = performance.now()
  let checks: CheckResult[] = []
  let error: string | undefined
  try {
    checks = await s.run(ctx)
  } catch (e) {
    // First line only: stack traces carry local paths and are in the trace file anyway.
    error = `${(e as Error).name}: ${(e as Error).message}`.split('\n')[0]!
  }
  const duration_ms = Math.round(performance.now() - t0)
  const metrics = { runs: ctx.runIds.length, model_turns: 0, input_tokens: 0, output_tokens: 0, mcp_calls: 0, distru_writes: tenant.writes.length, graph_node_spans: 0, mcp_call_spans: 0, duration_ms }
  for (const id of ctx.runIds) {
    const run = await ctx.harness.runs.getRun(TENANT_A, id)
    for (const c of run?.toolCalls ?? []) {
      if (c.server === 'model') {
        metrics.model_turns++
        metrics.input_tokens += c.inputTokens ?? 0
        metrics.output_tokens += c.outputTokens ?? 0
      } else if (c.server === 'distru' || c.server === 'workspace') metrics.mcp_calls++
    }
  }
  for (const sp of spans.getFinishedSpans()) {
    if (sp.name.startsWith('graph.node ')) metrics.graph_node_spans++
    if (sp.name.startsWith('mcp.call ')) metrics.mcp_call_spans++
  }
  await ctx.harness.close()
  const scored = values.live ? checks.filter((c) => !c.scriptedOnly) : checks
  return { id: s.id, title: s.title, pass: !error && scored.length > 0 && scored.every((c) => c.pass), ...(error ? { error } : {}), checks, metrics }
}

async function main(): Promise<number> {
  const db = createDb()
  await seedPrincipals(db)
  await db.$disconnect()

  const choice = values.live ? await liveChoice() : undefined
  const budget = Number(values['budget-usd'])
  const only = values.only?.split(',').map((x) => x.trim())
  const scenarios = SCENARIOS.filter((s) => !only || only.some((o) => s.id.startsWith(o)))
  const results: ScenarioResult[] = []
  const started = new Date().toISOString()

  let stopReason: string | undefined
  for (const s of scenarios) {
    if (values.live && cliUsage.costUsd >= budget) stopReason ??= `budget of $${budget} reached`
    if (stopReason) {
      results.push({ id: s.id, title: s.title, pass: false, skipped: stopReason, checks: [], metrics: { runs: 0, model_turns: 0, input_tokens: 0, output_tokens: 0, mcp_calls: 0, distru_writes: 0, graph_node_spans: 0, mcp_call_spans: 0, duration_ms: 0 } })
      out(`SKIP ${s.id} (${stopReason})`)
      continue
    }
    const r = await runScenario(s, choice ?? scriptedModels(s.scripted))
    // A model provider that refuses before answering (quota, rate wall) is "not run", not a model failure.
    if (values.live && r.error && /Quota/.test(r.error) && r.metrics.model_turns === 0) {
      stopReason = `not run: the model provider refused before any model turn (${r.error})`
      results.push({ ...r, pass: false, skipped: stopReason })
      out(`SKIP ${s.id} (${stopReason})`)
      continue
    }
    results.push(r)
    out(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}  (${r.metrics.duration_ms} ms, ${r.metrics.model_turns} model turns, ${r.metrics.mcp_calls} MCP calls, ${r.metrics.distru_writes} writes)`)
    for (const c of r.checks) if (!c.pass) out(`     x ${c.name}${c.scriptedOnly && values.live ? ' [scripted-only, not scored]' : ''}: ${c.detail}`)
    if (r.error) out(`     ! ${r.error.split('\n')[0]}`)
  }

  const passed = results.filter((r) => r.pass).length
  const ran = results.filter((r) => !r.skipped).length
  const checks = results.flatMap((r) => (values.live ? r.checks.filter((c) => !c.scriptedOnly) : r.checks))
  const summary = {
    mode: values.live ? 'live' : 'deterministic',
    model: choice?.modelName ?? 'scripted',
    transport: choice?.transport ?? null,
    started,
    finished: new Date().toISOString(),
    data: 'SYNTHETIC fixtures and an in-process mock of the published Distru API contract',
    scenarios: results.length,
    ran,
    passed,
    checks: { total: checks.length, passed: checks.filter((c) => c.pass).length },
    tokens: { input: results.reduce((n, r) => n + r.metrics.input_tokens, 0), output: results.reduce((n, r) => n + r.metrics.output_tokens, 0) },
    cost_usd: values.live && choice?.transport === 'claude-cli' ? Math.round(cliUsage.costUsd * 10_000) / 10_000 : null,
    served_models: values.live ? [...cliUsage.models] : [],
    stopped_early: stopReason ?? null,
    results,
  }
  const file = values.out ?? join(HERE, '..', 'results', values.live ? `live-${started.slice(0, 10)}.json` : 'deterministic.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`)
  if (stopReason) out(`stopped early: ${stopReason}`)
  out(`${summary.mode}: ${passed}/${results.length} scenarios passed (${ran} ran), ${summary.checks.passed}/${summary.checks.total} checks (${summary.model}${summary.cost_usd !== null ? `, $${summary.cost_usd}` : ''}) -> ${relative(process.cwd(), file)}`)
  return values.live || passed === results.length ? 0 : 1
}

try {
  process.exitCode = await main()
} finally {
  await telemetry.shutdown()
}
