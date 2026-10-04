#!/usr/bin/env node
// Summarises the OpenTelemetry JSONL trace for one run: spans by kind, MCP tool spans with latency.
// Usage: node scripts/trace-summary.mjs RUN_ID [.otel/traces.jsonl]
import { readFileSync } from 'node:fs'

const [runId, file = '.otel/traces.jsonl'] = process.argv.slice(2)
if (!runId) {
  console.error('usage: node scripts/trace-summary.mjs RUN_ID [trace file]')
  process.exit(2)
}
const spans = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((s) => s.attributes?.['opsharness.run_id'] === runId)

const byKind = {}
for (const s of spans) {
  const kind = s.name.split(' ')[0]
  byKind[kind] = (byKind[kind] ?? 0) + 1
}
console.log(`run ${runId}: ${spans.length} spans`, byKind)
for (const s of spans.filter((x) => x.name.startsWith('mcp.')).sort((a, b) => a.start.localeCompare(b.start))) {
  console.log(`  ${s.name.padEnd(36)} ${String(s.duration_ms.toFixed(1)).padStart(7)} ms  ${s.status}`)
}
