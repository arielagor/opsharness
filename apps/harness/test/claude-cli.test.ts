import { describe, expect, it } from 'vitest'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ClaudeCliChatModel, cliUsage } from '../src/index.js'

describe('claude-cli adapter (no model call: the wrapper is faked)', () => {
  it('renders tools into the prompt and turns a JSON reply into a tool call with usage', async () => {
    const seen: { prompt: string; opts: Record<string, unknown> }[] = []
    const fake = async (prompt: string, opts: Record<string, unknown>) => {
      seen.push({ prompt, opts })
      return { json: { tool: 'list_inbox', arguments: { limit: 5 } }, model: 'fake-model', cost_usd: 0.01, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 } }
    }
    const model = new ClaudeCliChatModel(fake, 'standard').bindTools([{ type: 'function', function: { name: 'list_inbox', description: 'List mail', parameters: { type: 'object' } } }])
    const msg = await model.invoke([new SystemMessage('be careful'), new HumanMessage('read the inbox')])
    expect(msg.tool_calls).toEqual([expect.objectContaining({ name: 'list_inbox', args: { limit: 5 } })])
    expect(msg.usage_metadata).toMatchObject({ input_tokens: 120, output_tokens: 7 })
    expect(seen[0]!.prompt).toContain('- list_inbox: List mail')
    expect(seen[0]!.opts).toMatchObject({ tier: 'standard', json: true, systemPrompt: 'be careful' })
    expect(cliUsage.costUsd).toBeGreaterThanOrEqual(0.01)
  })
})
