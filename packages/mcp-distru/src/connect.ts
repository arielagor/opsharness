import { DistruClient, type DistruClientOptions } from '@opsharness/distru-client'
import { createMockDistru, MOCK_TOKENS, type MockDistru, type MockDistruOptions } from '@opsharness/distru-mock'

/** Resolves a tenant to a Distru client carrying THAT tenant's token. Nothing else picks tokens. */
export interface DistruConnection {
  clientFor(tenantId: string): DistruClient
  /** Present when backed by the in-process mock (tests, evals, demos). */
  mock?: MockDistru
}

const MOCK_ORIGIN = 'https://mock.distru.invalid'
const MOCK_TENANT_TOKENS: Record<string, string> = { 'tenant-a': MOCK_TOKENS.tenantAFull, 'tenant-b': MOCK_TOKENS.tenantBFull }

/** The in-process mock, with SYNTHETIC data. */
export function mockConnection(
  opts: MockDistruOptions & Pick<DistruClientOptions, 'sleep' | 'onRequest' | 'maxRateLimitRetries'> & { mock?: MockDistru } = {},
): DistruConnection {
  const mock = opts.mock ?? createMockDistru({ validateResponses: true, ...opts })
  return {
    mock,
    clientFor(tenantId) {
      const token = MOCK_TENANT_TOKENS[tenantId]
      if (!token) throw new Error(`No mock credentials for tenant ${tenantId}`)
      return new DistruClient({
        baseUrl: MOCK_ORIGIN,
        token,
        fetch: mock.fetch,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.onRequest ? { onRequest: opts.onRequest } : {}),
        ...(opts.maxRateLimitRetries !== undefined ? { maxRateLimitRetries: opts.maxRateLimitRetries } : {}),
      })
    },
  }
}

/**
 * DISTRU_BASE_URL plus DISTRU_TOKENS (a JSON map of tenant id to API token) selects a real
 * endpoint. Without them, the in-process mock is used. This project has only ever run against
 * the mock.
 */
export function connectionFromEnv(env: NodeJS.ProcessEnv = process.env): DistruConnection {
  const baseUrl = env['DISTRU_BASE_URL']
  const tokens = env['DISTRU_TOKENS']
  if (!baseUrl || !tokens) return mockConnection()
  const map = JSON.parse(tokens) as Record<string, string>
  return {
    clientFor(tenantId) {
      const token = map[tenantId]
      if (!token) throw new Error(`No Distru token configured for tenant ${tenantId}`)
      return new DistruClient({ baseUrl, token })
    },
  }
}
