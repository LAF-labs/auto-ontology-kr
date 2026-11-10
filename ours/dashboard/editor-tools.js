/**
 * Dashboard editing tools, mounted per agent as a preset row:
 *
 *   - id: dashboard-editor-tools
 *     name: '@ours/dashboard/editor-tools'
 *     config: { maxRows: 10 }
 *
 * Each call resolves the draft from the calling Session's binding in
 * `ctx.dashboardStore`; a Session no edit button opened gets `not_bound`.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { editorToolSpecs } from './src/editor.js'

export const name = 'dashboard-editor-tools'
export const inject = ['tools', 'dashboardStore', 'aoConnector']

export const Config = z.object({
  maxRows: z.natural().min(1).default(10).description('Preview rows of a saved analysis returned to the model.'),
})

export function apply(ctx, config) {
  const service = ctx.dashboardStore
  const specs = editorToolSpecs({ store: service.store, connector: ctx.aoConnector, gate: service.gate, maxRows: config.maxRows })
  for (const spec of specs) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => spec.execute(args, { sessionId: exec.agent?.id, signal: exec.signal }),
    }))
  }
}
