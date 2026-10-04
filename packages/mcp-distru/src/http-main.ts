#!/usr/bin/env node
import { DEMO_PRINCIPALS } from '@opsharness/core'
import { initTelemetry, log } from '@opsharness/telemetry'
import { connectionFromEnv } from './connect.js'
import { serveMcpOverHttp } from './http.js'
import { InMemoryPlanStore } from './plans.js'
import { buildDistruMcpServer } from './server.js'

/**
 * Streamable HTTP entrypoint for local demos. Bearer tokens are `demo:<principal id>` for the
 * SYNTHETIC demo principals. A deployment would put a real identity provider here.
 */
if (process.env['OPSHARNESS_TRACE_FILE']) initTelemetry({ serviceName: 'mcp-distru', file: process.env['OPSHARNESS_TRACE_FILE'] })
const conn = connectionFromEnv()
const plans = new InMemoryPlanStore()
const { url } = await serveMcpOverHttp({
  port: Number(process.env['MCP_DISTRU_PORT'] ?? 4020),
  authenticate: (token) => DEMO_PRINCIPALS.find((p) => `demo:${p.id}` === token),
  build: (principal) => buildDistruMcpServer({ principal, client: conn.clientFor(principal.tenantId), plans }),
})
log.info('mcp-distru http ready', { url })
