export { buildDistruMcpServer, toolErrorMessage, tierUnitPrice, TOOL_SCOPES, type DistruServerOptions } from './server.js'
export { proposeOrderChange, renderSummary, ProposeError, type ProposeInput, type ProposedLine } from './propose.js'
export { applyPlan, ApplyError, type ApplyOutcome } from './apply.js'
export {
  InMemoryPlanStore,
  checkDecision,
  planHash,
  newPlanId,
  DecisionError,
  type Plan,
  type PlanDiff,
  type PlanStatus,
  type PlanStore,
  type LineView,
  type FieldChange,
  type Approval,
  type AppliedResult,
  type ClaimResult,
  type Decision,
  type DecisionInput,
} from './plans.js'
export { mockConnection, connectionFromEnv, type DistruConnection } from './connect.js'
export { serveMcpOverHttp, type HttpMcpOptions } from './http.js'
