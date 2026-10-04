#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { demoPrincipal } from '@opsharness/core'
import { initTelemetry, log } from '@opsharness/telemetry'
import { connectionFromEnv } from './connect.js'
import { InMemoryPlanStore } from './plans.js'
import { buildDistruMcpServer } from './server.js'

/**
 * stdio entrypoint. OPSHARNESS_PRINCIPAL picks a SYNTHETIC demo principal (default: the ERP
 * agent of tenant A). Logs go to stderr; stdout carries the protocol.
 */
const principal = demoPrincipal(process.env['OPSHARNESS_PRINCIPAL'] ?? 'agent-erp@tenant-a')
if (process.env['OPSHARNESS_TRACE_FILE']) initTelemetry({ serviceName: 'mcp-distru', file: process.env['OPSHARNESS_TRACE_FILE'] })
const conn = connectionFromEnv()
const server = buildDistruMcpServer({ principal, client: conn.clientFor(principal.tenantId), plans: new InMemoryPlanStore() })
await server.connect(new StdioServerTransport())
log.info('mcp-distru stdio ready', { principal_id: principal.id, backend: conn.mock ? 'in-process mock (synthetic)' : 'DISTRU_BASE_URL' })
