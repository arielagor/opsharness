import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SPEC_SHA256,
  SUBSET,
  distruSpec,
  nullabilityPatchReport,
  operation,
  patchNullable,
  requestBodySchema,
  responseSchema,
  verbatimSpec,
  verbatimSpecSha256,
} from '../src/index.js'
// @ts-expect-error plain .mjs helper without types
import { generateTypes } from '../scripts/generate-lib.mjs'

describe('the verbatim spec', () => {
  it('is the file published by Distru, byte for byte', () => {
    expect(verbatimSpecSha256()).toBe(SPEC_SHA256)
    expect(verbatimSpec().openapi).toBe('3.0.0')
    expect(Object.keys(verbatimSpec().paths)).toHaveLength(129)
  })

  it('contains every operation in the implemented subset', () => {
    for (const [method, path] of SUBSET) expect(() => operation(method, path)).not.toThrow()
  })

  it('declares the single error envelope on every error response of the subset', () => {
    for (const [method, path] of SUBSET) {
      const op = operation(method, path)
      for (const [status, res] of Object.entries(op.responses)) {
        if (Number(status) < 400) continue
        const schema = Object.values(res.content ?? {})[0]?.schema as { $ref?: string } | undefined
        expect(schema?.$ref, `${method} ${path} ${status}`).toBe('#/components/schemas/ErrorResponse')
      }
    }
  })

  it('never declares a 422 anywhere (the API does not return one)', () => {
    for (const ops of Object.values(verbatimSpec().paths)) {
      for (const op of Object.values(ops)) expect(Object.keys(op.responses)).not.toContain('422')
    }
  })

  it('only rate-limits PDF endpoints (every declared 429 is on a path ending in /pdf)', () => {
    for (const [path, ops] of Object.entries(verbatimSpec().paths)) {
      for (const op of Object.values(ops)) {
        if ('429' in op.responses) expect(path.endsWith('/pdf'), path).toBe(true)
      }
    }
  })
})

describe('nullability patch', () => {
  it('marks next_page nullable on list envelopes', () => {
    const products = distruSpec().components.schemas['Products'] as {
      properties: { next_page: { nullable?: boolean } }
    }
    expect(products.properties.next_page.nullable).toBe(true)
  })

  it('leaves the verbatim document untouched', () => {
    const products = verbatimSpec().components.schemas['Products'] as {
      properties: { next_page: { nullable?: boolean } }
    }
    expect(products.properties.next_page.nullable).toBeUndefined()
  })

  it('never patches a required property, a $ref, or prose that denies null', () => {
    const { spec, report } = patchNullable({
      components: {
        schemas: {
          A: {
            required: ['req'],
            properties: {
              req: { type: 'string', description: 'null when unset' },
              opt: { type: 'string', description: 'Null when unset' },
              never: { type: 'string', description: 'Always present and never null.' },
              ref: { $ref: '#/components/schemas/B', description: 'null when unset' },
              silent: { type: 'string', description: 'A name' },
            },
          },
        },
      },
    })
    const props = (spec as { components: { schemas: { A: { properties: Record<string, { nullable?: boolean }> } } } })
      .components.schemas.A.properties
    expect(props['opt']?.nullable).toBe(true)
    expect(props['req']?.nullable).toBeUndefined()
    expect(props['never']?.nullable).toBeUndefined()
    expect(props['ref']?.nullable).toBeUndefined()
    expect(props['silent']?.nullable).toBeUndefined()
    expect(report.patched).toEqual(['components.schemas.A.properties.opt'])
  })

  it('reports how many properties it made nullable', () => {
    // Printed so VERIFY.md can quote the number; asserted loosely so a spec update does not
    // silently change it without someone looking.
    const count = nullabilityPatchReport().patched.length
    console.info(`nullability patch: ${count} optional properties marked nullable`)
    expect(count).toBeGreaterThan(500)
  })
})

describe('schema helpers', () => {
  it('resolves the PDF request body through components/requestBodies', () => {
    const schema = requestBodySchema('post', '/public/v1/orders/{id}/pdf') as { required: string[] }
    expect(schema.required).toEqual(['format'])
  })

  it('returns response schemas by status', () => {
    expect(responseSchema('get', '/public/v1/orders/{id}', 404)).toEqual({ $ref: '#/components/schemas/ErrorResponse' })
    expect(responseSchema('get', '/public/v1/orders/{id}', 599)).toBeUndefined()
  })

  it('throws on an operation outside the spec', () => {
    expect(() => operation('put', '/public/v1/orders')).toThrow(/No PUT/)
  })
})

describe('generated types', () => {
  it('match a fresh generation from the spec (no drift)', async () => {
    const committed = readFileSync(new URL('../src/generated/distru.ts', import.meta.url), 'utf8')
    const fresh: string = await generateTypes(verbatimSpec(), patchNullable)
    expect(committed === fresh, 'run `pnpm --filter @opsharness/distru-contract gen`').toBe(true)
  })
})
