// Regenerates src/generated/distru.ts from openapi.json + the nullability patch.
// Run with `pnpm --filter @opsharness/distru-contract gen` (builds first, so dist/patch.js exists).
// test/contract.test.ts fails if the committed file drifts from this output.
import { readFileSync, writeFileSync } from 'node:fs'
import { patchNullable } from '../dist/patch.js'
import { generateTypes } from './generate-lib.mjs'

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
const out = await generateTypes(spec, patchNullable)
writeFileSync(new URL('../src/generated/distru.ts', import.meta.url), out)
console.log(`wrote src/generated/distru.ts (${out.length} chars)`)
