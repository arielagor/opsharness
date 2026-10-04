import { randomUUID } from 'node:crypto'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { HumanMessage, SystemMessage, ToolMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages'
import { log, withSpan } from '@opsharness/telemetry'
import { traceIdNow, type AuditSink, type Toolbox } from './toolbox.js'

/** A tool the harness itself handles: it ends the specialist's turn with a structured result. */
export interface TerminalTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface SpecialistResult {
  terminal: { name: string; args: Record<string, unknown> } | null
  turns: number
  inputTokens: number
  outputTokens: number
  /** Every MCP tool result the specialist saw, for deterministic checks downstream. */
  observations: { tool: string; isError: boolean; text: string; data: Record<string, unknown> }[]
}

export interface SpecialistOptions {
  node: 'intake' | 'erp'
  model: BaseChatModel
  modelName: string
  system: string
  task: string
  toolbox: Toolbox
  terminal: TerminalTool[]
  maxTurns: number
  runId: string
  audit: AuditSink
}

const asToolDef = (name: string, description: string, parameters: Record<string, unknown>) => ({ type: 'function' as const, function: { name, description, parameters } })

/**
 * A small tool-calling loop. The model only ever sees the tools the MCP server listed for this
 * specialist's principal, plus the terminal tools. Each model turn and each tool call is a span
 * and an audit row; tokens are recorded per turn and attributed to the calls that turn made.
 */
export async function runSpecialist(o: SpecialistOptions): Promise<SpecialistResult> {
  const defs = [...o.toolbox.tools.map((t) => asToolDef(t.name, t.description, t.inputSchema)), ...o.terminal.map((t) => asToolDef(t.name, t.description, t.parameters))]
  if (!o.model.bindTools) throw new Error(`Model ${o.modelName} cannot call tools`)
  const bound = o.model.bindTools(defs)
  const terminalNames = new Set(o.terminal.map((t) => t.name))
  const messages: BaseMessage[] = [new SystemMessage(o.system), new HumanMessage(o.task)]
  const out: SpecialistResult = { terminal: null, turns: 0, inputTokens: 0, outputTokens: 0, observations: [] }

  while (out.turns < o.maxTurns) {
    out.turns++
    const turnId = randomUUID()
    const startedAt = new Date()
    const t0 = performance.now()
    let ai: AIMessage
    try {
      ai = (await withSpan(`llm.turn ${o.node}`, { 'llm.model': o.modelName, 'opsharness.node': o.node, 'llm.turn': out.turns }, async (span) => {
        const r = (await bound.invoke(messages)) as AIMessage
        span.setAttribute('llm.input_tokens', r.usage_metadata?.input_tokens ?? 0)
        span.setAttribute('llm.output_tokens', r.usage_metadata?.output_tokens ?? 0)
        span.setAttribute('llm.tool_calls', (r.tool_calls ?? []).map((c) => c.name).join(','))
        return r
      })) as AIMessage
    } catch (e) {
      await o.audit({ runId: o.runId, tenantId: o.toolbox.principal.tenantId, principalId: o.toolbox.principal.id, server: 'model', tool: o.modelName, node: o.node, args: { turn: out.turns }, ok: false, error: String((e as Error).message).slice(0, 2000), latencyMs: performance.now() - t0, modelTurnId: turnId, startedAt: startedAt.toISOString() })
      throw e
    }
    const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000
    const inputTokens = ai.usage_metadata?.input_tokens ?? 0
    const outputTokens = ai.usage_metadata?.output_tokens ?? 0
    out.inputTokens += inputTokens
    out.outputTokens += outputTokens
    const calls = ai.tool_calls ?? []
    await o.audit({
      runId: o.runId,
      tenantId: o.toolbox.principal.tenantId,
      principalId: o.toolbox.principal.id,
      server: 'model',
      tool: o.modelName,
      node: o.node,
      args: { turn: out.turns, tool_calls: calls.map((c) => c.name) },
      ok: true,
      latencyMs,
      inputTokens,
      outputTokens,
      modelTurnId: turnId,
      ...(traceIdNow() ? { traceId: traceIdNow()! } : {}),
      startedAt: startedAt.toISOString(),
    })
    messages.push(ai)

    if (calls.length === 0) {
      messages.push(new HumanMessage(`Respond by calling exactly one of the tools. To finish, call ${[...terminalNames].join(' or ')}.`))
      continue
    }
    for (const call of calls) {
      const args = (call.args ?? {}) as Record<string, unknown>
      if (terminalNames.has(call.name)) {
        out.terminal = { name: call.name, args }
        log.info('specialist finished', { node: o.node, terminal: call.name, turns: out.turns })
        return out
      }
      const r = await o.toolbox.call(call.name, args, { node: o.node, modelTurnId: turnId, inputTokens, outputTokens })
      out.observations.push({ tool: call.name, ...r })
      messages.push(new ToolMessage({ content: r.isError ? `ERROR: ${r.text}` : r.text, tool_call_id: call.id ?? `call_${randomUUID()}`, name: call.name }))
    }
  }
  log.warn('specialist ran out of turns', { node: o.node, turns: out.turns })
  return out
}
