/** GraphQL documents used by the pages. The same documents work against POST /api/graphql. */

export const VIEWER = /* GraphQL */ `
  query Viewer { viewer { id tenantName displayName canApprove } approvals { id } }
`

export const RUNS = /* GraphQL */ `
  query Runs($status: [RunStatus!]) {
    runs(status: $status, limit: 100) { id sourceKind sourceRef status mode model summary createdAt usage { modelTurns inputTokens outputTokens toolCalls } }
  }
`

const PLAN_FIELDS = /* GraphQL */ `
  id runId status kind orderNumber customer destructive destructiveReasons summary rationale hash createdAt
  header { field from to }
  lines {
    added { lineId sku name quantity price }
    changed { lineId sku name quantity price changes { field from to } }
    kept { lineId sku name quantity price }
    deleted { lineId sku name quantity price }
  }
  approval { decision approverId acknowledgeDestructive decidedAt note }
`

export const RUN = /* GraphQL */ `
  query Run($id: ID!) {
    run(id: $id) {
      id sourceKind sourceRef status mode model summary createdAt updatedAt trail warnings blockers injectionSuspected
      usage { modelTurns inputTokens outputTokens modelLatencyMs toolCalls toolLatencyMs }
      toolCalls { id server tool node principalId ok error latencyMs inputTokens outputTokens traceId startedAt args result }
      plans { ${PLAN_FIELDS} }
    }
  }
`

export const APPROVALS = /* GraphQL */ `
  query Approvals { viewer { canApprove } approvals { ${PLAN_FIELDS} } }
`

export const DECIDE = /* GraphQL */ `
  mutation Decide($planId: ID!, $planHash: String!, $decision: Decision!, $acknowledgeDestructive: Boolean!, $note: String) {
    decide(planId: $planId, planHash: $planHash, decision: $decision, acknowledgeDestructive: $acknowledgeDestructive, note: $note) { ok error planId decision }
  }
`

export type RunStatus = 'RUNNING' | 'AWAITING_APPROVAL' | 'APPLIED' | 'REJECTED' | 'BLOCKED' | 'NEEDS_CLARIFICATION' | 'FAILED'

export interface LineV { lineId: string | null; sku: string; name: string; quantity: number; price: number }
export interface FieldChangeV { field: string; from: string | null; to: string | null }
export interface PlanV {
  id: string
  runId: string | null
  status: string
  kind: string
  orderNumber: string | null
  customer: string | null
  destructive: boolean
  destructiveReasons: string[]
  summary: string
  rationale: string
  hash: string
  createdAt: string
  header: FieldChangeV[]
  lines: { added: LineV[]; changed: (LineV & { changes: FieldChangeV[] })[]; kept: LineV[]; deleted: LineV[] }
  approval: { decision: string; approverId: string; acknowledgeDestructive: boolean; decidedAt: string; note: string | null } | null
}
export interface RunListItem {
  id: string
  sourceKind: string
  sourceRef: string
  status: RunStatus
  mode: string
  model: string | null
  summary: string | null
  createdAt: string
  usage: { modelTurns: number; inputTokens: number; outputTokens: number; toolCalls: number }
}
export interface ToolCallV {
  id: string
  server: string
  tool: string
  node: string | null
  principalId: string
  ok: boolean
  error: string | null
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  traceId: string | null
  startedAt: string
  args: string
  result: string | null
}
export interface RunV extends Omit<RunListItem, 'usage'> {
  updatedAt: string
  trail: string[]
  warnings: string[]
  blockers: string[]
  injectionSuspected: boolean
  usage: RunListItem['usage'] & { modelLatencyMs: number; toolLatencyMs: number }
  toolCalls: ToolCallV[]
  plans: PlanV[]
}
