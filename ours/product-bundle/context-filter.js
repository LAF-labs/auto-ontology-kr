/**
 * Drops named optional runtime-context entries (for example the file sandbox
 * and approval policy sentences) from every model request. Required contexts
 * are restored by the system prompt and cannot be removed here.
 */
import z from '@deepseek-ai/schemastery'
import { createContextFilter } from './src/context-filter.js'

export const name = 'context-filter'

export const inject = ['systemPrompt']

export const Config = z.object({
  dropContexts: z.array(z.string()).default([]).description('Runtime-context entry names to remove from model requests.'),
})

export function apply(ctx, config) {
  ctx.on('system-prompt/assemble', createContextFilter(config.dropContexts))
}
