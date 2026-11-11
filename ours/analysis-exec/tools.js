/**
 * Agent tools over ctx.analysisExec, mounted per agent as a preset row:
 *
 *   - id: analysis-exec-tools
 *     name: '@ours/analysis-exec/tools'
 *
 * Inputs, runs and results belong to the calling Session.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { analysisToolSpecs, TOOL_NAMES } from './src/tool-specs.js'

export const name = 'analysis-exec-tools'
export const inject = ['tools', 'analysisExec']

export const Config = z.object({
  tools: z.array(z.union(TOOL_NAMES)).default([...TOOL_NAMES]).description('Tools this preset exposes.'),
})

/** Some models send an object or array argument as JSON text; read it as the value it spells. */
function decodeJsonText(args) {
  const decoded = { ...args }
  for (const key of ['params', 'inputs', 'assumptions', 'interval', 'tables', 'figures', 'highlights']) {
    if (typeof decoded[key] !== 'string') continue
    try { decoded[key] = JSON.parse(decoded[key]) } catch { /* not JSON: the tool names the field */ }
  }
  return decoded
}

export function apply(ctx, config) {
  const enabled = new Set(config.tools)
  for (const spec of analysisToolSpecs(ctx.analysisExec.runs)) {
    if (!enabled.has(spec.name)) continue
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => spec.execute(decodeJsonText(args), { sessionId: exec.agent?.id, signal: exec.signal }),
    }))
  }
}
