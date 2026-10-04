#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createDb, seedPrincipals } from '@opsharness/db'
import { connectionFromEnv } from '@opsharness/mcp-distru'
import { initTelemetry, log } from '@opsharness/telemetry'
import { Harness } from './harness.js'
import { anthropicModels, scriptedModels, type ModelChoice } from './models.js'
import { claudeCliModels } from './claude-cli.js'
import type { Source } from './types.js'

const USAGE = `opsharness <command> [options]   (SYNTHETIC data; Distru mock unless DISTRU_BASE_URL is set)

  seed                                   upsert the synthetic tenants and principals
  run --tenant T (--email ID | --sheet ID) [--live]
                                         run one source until it finishes or waits for approval
  resume --tenant T RUN_ID               continue a run whose plan has a recorded decision
  worker [--once] [--interval MS]        resume every run that has a recorded decision
  demo                                   run seven SYNTHETIC fixtures for tenant-a to fill the console

Env: DATABASE_URL, OPSHARNESS_MODEL (live), ANTHROPIC_API_KEY or OPSHARNESS_LEAN_CLAUDE (live),
     OPSHARNESS_TRACE_FILE (default .otel/traces.jsonl), DISTRU_BASE_URL + DISTRU_TOKENS.`

/**
 * The demo runs the deliberately naive scripted model, except where noted: 010 (an explicit
 * removal) needs a model that keeps the other lines by id, or its plan would delete them too.
 */
const DEMO_SOURCES: (Source & { careful?: boolean })[] = [
  { kind: 'email', ref: '001-harborview-new-order' },
  { kind: 'email', ref: '005-harborview-change-quantity' },
  { kind: 'email', ref: '010-harborview-remove-line', careful: true },
  { kind: 'sheet', ref: 'pelican-weekly-2026-10-01' },
  { kind: 'email', ref: '003-pelican-over-inventory' },
  { kind: 'email', ref: '006-juniper-prompt-injection' },
  { kind: 'email', ref: '002-cinder-ambiguous' },
]

async function models(live: boolean): Promise<ModelChoice> {
  if (!live) return scriptedModels()
  const m = (await anthropicModels()) ?? (await claudeCliModels())
  if (!m) throw new Error('--live needs OPSHARNESS_MODEL plus ANTHROPIC_API_KEY or OPSHARNESS_LEAN_CLAUDE')
  return m
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: 'string', default: 'tenant-a' },
    email: { type: 'string' },
    sheet: { type: 'string' },
    live: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    interval: { type: 'string', default: '2000' },
  },
})
const [command, arg] = positionals
const telemetry = initTelemetry({ serviceName: 'opsharness-harness', file: process.env['OPSHARNESS_TRACE_FILE'] ?? '.otel/traces.jsonl' })
const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)

try {
  if (command === 'seed') {
    const db = createDb()
    await seedPrincipals(db)
    await db.$disconnect()
    print({ seeded: true })
  } else if (command === 'run' || command === 'resume' || command === 'worker' || command === 'demo') {
    const m = await models(values.live)
    const harness = await Harness.create({ connection: connectionFromEnv(), model: m.model, modelName: m.modelName, mode: m.mode })
    try {
      if (command === 'run') {
        if (!values.email && !values.sheet) throw new Error('run needs --email or --sheet')
        const r = await harness.start(values.tenant, values.email ? { kind: 'email', ref: values.email } : { kind: 'sheet', ref: values.sheet! })
        print({ run_id: r.runId, status: r.status, proposal: r.state.proposal, verdict: r.state.verdict, clarification: r.state.clarification, trail: r.state.trail })
      } else if (command === 'demo') {
        if (!process.env['DISTRU_BASE_URL']) log.warn('DISTRU_BASE_URL is not set: this process uses its own in-process mock, so a worker in another process will apply to a different mock')
        const careful = { ...scriptedModels({ keepExistingLines: true }), modelName: 'scripted, keeps lines by id' }
        const carefulHarness = await Harness.create({ connection: connectionFromEnv(), model: careful.model, modelName: careful.modelName, mode: careful.mode })
        try {
          for (const { careful: useCareful, ...source } of DEMO_SOURCES) {
            const r = await (useCareful ? carefulHarness : harness).start('tenant-a', source)
            print({ source: source.ref, run_id: r.runId, status: r.status })
          }
        } finally {
          await carefulHarness.close()
        }
      } else if (command === 'resume') {
        if (!arg) throw new Error('resume needs a RUN_ID')
        const r = await harness.resume(values.tenant, arg)
        print({ run_id: r.runId, status: r.status, apply: r.state.applyResult, pdf: r.state.pdf, trail: r.state.trail })
      } else {
        const interval = Number(values.interval)
        log.info('worker started', { interval_ms: interval })
        for (;;) {
          const done = await harness.resumeDecided()
          for (const r of done) print({ run_id: r.runId, status: r.status })
          if (values.once) break
          await new Promise((res) => setTimeout(res, interval))
        }
      }
    } finally {
      await harness.close()
    }
  } else {
    process.stdout.write(`${USAGE}\n`)
    process.exitCode = command ? 1 : 0
  }
} finally {
  await telemetry.shutdown()
}
