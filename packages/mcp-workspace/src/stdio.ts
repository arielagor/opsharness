#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { demoPrincipal } from '@opsharness/core'
import { log } from '@opsharness/telemetry'
import { buildWorkspaceMcpServer } from './server.js'

const principal = demoPrincipal(process.env['OPSHARNESS_PRINCIPAL'] ?? 'agent-intake@tenant-a')
await buildWorkspaceMcpServer({ principal }).connect(new StdioServerTransport())
log.info('mcp-workspace stdio ready', { principal_id: principal.id })
