/**
 * Refuses shared-API requests whose normalized path starts with a denied
 * prefix, before the request body is read (`connection/request` waterfall).
 * Only authenticated HTTP requests pass this waterfall; WebSocket streams do not.
 */
import z from '@deepseek-ai/schemastery'
import { createRequestGuard } from './src/guard.js'

export const name = 'request-guard'

export const Config = z.object({
  denyPathPrefixes: z.array(z.string()).default([]).description('Absolute path prefixes under /api to refuse with 403.'),
})

export function apply(ctx, config) {
  ctx.on('connection/request', createRequestGuard(config.denyPathPrefixes))
}
