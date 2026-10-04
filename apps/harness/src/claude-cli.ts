import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { BaseChatModel, type BaseChatModelParams, type BindToolsInput } from '@langchain/core/language_models/chat_models'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { ChatResult } from '@langchain/core/outputs'
import type { ModelChoice } from './models.js'

/**
 * OPTIONAL live transport for a machine with no API key: a Claude Code CLI wrapper that takes a
 * prompt and returns JSON (the author's `lean-claude.mjs`, pointed to by OPSHARNESS_LEAN_CLAUDE).
 * It has no native tool use, so tools are described in the prompt and the model must answer with
 * {"tool": name, "arguments": {...}}. That is a weaker protocol than the API's tool calling, and
 * results from it are labelled with transport "claude-cli".
 */
interface RunClaude {
  (prompt: string, opts: Record<string, unknown>): Promise<{ json: unknown; model: string; cost_usd: number | null; usage: Record<string, number | undefined> }>
}

interface ToolDef {
  name: string
  description: string
  parameters: unknown
}

export const cliUsage = { calls: 0, costUsd: 0, models: new Set<string>() }

function textOf(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : m.content.map((c) => ('text' in c ? String(c.text) : '')).join('')
}

function render(messages: BaseMessage[], tools: ToolDef[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.getType() === 'system').map(textOf).join('\n')
  const lines: string[] = ['TOOLS (call exactly one per reply):']
  for (const t of tools) lines.push(`- ${t.name}: ${t.description}\n  input JSON schema: ${JSON.stringify(t.parameters)}`)
  lines.push('', 'CONVERSATION SO FAR:')
  for (const m of messages) {
    const type = m.getType()
    if (type === 'human') lines.push(`[user]\n${textOf(m)}`)
    else if (type === 'ai') for (const c of (m as AIMessage).tool_calls ?? []) lines.push(`[you called ${c.name}] ${JSON.stringify(c.args)}`)
    else if (ToolMessage.isInstance(m)) lines.push(`[result of ${m.name}]\n${textOf(m)}`)
  }
  lines.push('', 'Reply with ONLY one JSON object of the form {"tool": "<tool name>", "arguments": { ... }} and nothing else.')
  return { system, prompt: lines.join('\n') }
}

export class ClaudeCliChatModel extends BaseChatModel {
  constructor(
    private readonly runClaude: RunClaude,
    private readonly tier: string,
    private readonly tools: ToolDef[] = [],
    params: BaseChatModelParams = {},
  ) {
    super(params)
  }

  _llmType(): string {
    return 'claude-cli'
  }

  override bindTools(tools: BindToolsInput[]): ClaudeCliChatModel {
    const defs = tools.map((t) => {
      const f = (t as { function: ToolDef }).function
      return { name: f.name, description: f.description, parameters: f.parameters }
    })
    return new ClaudeCliChatModel(this.runClaude, this.tier, defs)
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const { system, prompt } = render(messages, this.tools)
    const r = await this.runClaude(prompt, { job: 'opsharness:live', tier: this.tier, json: true, effort: 'low', systemPrompt: system, maxUsd: 1, retries: 1, timeoutMs: 180_000 })
    cliUsage.calls++
    cliUsage.costUsd += r.cost_usd ?? 0
    cliUsage.models.add(r.model)
    const j = (r.json ?? {}) as { tool?: string; arguments?: Record<string, unknown> }
    const u = r.usage
    const input = (u['input_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0) + (u['cache_read_input_tokens'] ?? 0)
    const output = u['output_tokens'] ?? 0
    const message = new AIMessage({
      content: j.tool ? '' : JSON.stringify(r.json),
      tool_calls: j.tool ? [{ id: `call_${randomUUID()}`, name: j.tool, args: j.arguments ?? {}, type: 'tool_call' }] : [],
      usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
      response_metadata: { model: r.model },
    })
    return { generations: [{ text: '', message }] }
  }
}

/** Returns undefined unless OPSHARNESS_LEAN_CLAUDE points at the wrapper module. */
export async function claudeCliModels(env: NodeJS.ProcessEnv = process.env): Promise<ModelChoice | undefined> {
  const path = env['OPSHARNESS_LEAN_CLAUDE']
  if (!path) return undefined
  const mod = (await import(pathToFileURL(path).href)) as { runClaude: RunClaude }
  const tier = env['OPSHARNESS_MODEL'] ?? 'standard'
  return { model: () => new ClaudeCliChatModel(mod.runClaude, tier), modelName: `claude-cli:${tier}`, mode: 'live', transport: 'claude-cli' }
}
