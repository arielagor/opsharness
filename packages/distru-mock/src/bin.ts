#!/usr/bin/env node
import { MOCK_TOKENS, serveMockDistru } from './index.js'

const port = Number(process.env['DISTRU_MOCK_PORT'] ?? 4010)
const { url } = await serveMockDistru(port, { validateResponses: true })
process.stdout.write(`distru-mock (SYNTHETIC data, unofficial) listening at ${url}\n`)
process.stdout.write(`tokens: ${Object.values(MOCK_TOKENS).join(', ')}\n`)
