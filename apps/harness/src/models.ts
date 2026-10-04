import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ScriptedChatModel, type ScriptBehaviour } from './scripted.js'
import type { Role } from './graph.js'

export interface ModelChoice {
  model: (role: Role) => BaseChatModel
  modelName: string
  mode: 'scripted' | 'live'
  /** How a live model is reached, recorded with eval results. */
  transport?: 'anthropic-api' | 'claude-cli'
}

export function scriptedModels(behaviour: ScriptBehaviour = {}): ModelChoice {
  return { model: (role) => new ScriptedChatModel(role, behaviour), modelName: 'scripted', mode: 'scripted' }
}

/**
 * A live model through the Anthropic API. The model id comes from OPSHARNESS_MODEL and is never
 * hard-coded. Returns undefined when either variable is missing.
 */
export async function anthropicModels(env: NodeJS.ProcessEnv = process.env): Promise<ModelChoice | undefined> {
  const id = env['OPSHARNESS_MODEL']
  if (!env['ANTHROPIC_API_KEY'] || !id) return undefined
  const { ChatAnthropic } = await import('@langchain/anthropic')
  return { model: () => new ChatAnthropic({ model: id, temperature: 0, maxTokens: 2048 }), modelName: id, mode: 'live', transport: 'anthropic-api' }
}
