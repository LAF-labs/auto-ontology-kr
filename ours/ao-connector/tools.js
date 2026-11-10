/**
 * Agent tools over ctx.aoConnector, mounted per agent as a preset row:
 *
 *   - id: ao-tools
 *     name: '@ours/ao-connector/tools'
 *     config: { tools: [ao_list_analyses, ...], maxRows: 200 }
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { aoToolSpecs, TOOL_NAMES } from './src/tool-specs.js'

export const name = 'ao-connector-tools'
export const inject = ['tools', 'aoConnector']

export const Config = z.object({
  tools: z.array(z.union(TOOL_NAMES)).default([...TOOL_NAMES]).description('Tools this preset exposes.'),
  maxRows: z.natural().min(1).default(200).description('Rows returned to the model per result; the rest are cut and reported.'),
})

export function apply(ctx, config) {
  const enabled = new Set(config.tools)
  for (const spec of aoToolSpecs(ctx.aoConnector, { maxRows: config.maxRows })) {
    if (!enabled.has(spec.name)) continue
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => spec.execute(args, exec.signal),
    }))
  }
}
