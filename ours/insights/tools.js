/**
 * Report and alert tools, mounted per agent as a preset row (analysis presets only):
 *
 *   - id: insights-tools
 *     name: '@ours/insights/tools'
 *     config: { tools: [report_save, report_list, report_read, alert_propose_rule, alert_list] }
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { insightsToolSpecs, TOOL_NAMES } from './src/tool-specs.js'

export const name = 'insights-tools'
export const inject = ['tools', 'insights']

export const Config = z.object({
  tools: z.array(z.union(TOOL_NAMES)).default([...TOOL_NAMES]).description('Tools this preset exposes.'),
})

export function apply(ctx, config) {
  const service = ctx.insights
  const enabled = new Set(config.tools)
  const specs = insightsToolSpecs({
    reports: service.reports, alerts: service.alerts,
    triggerOf: (sessionId, hintId) => service.triggerOf(sessionId, hintId),
    onReport: report => service.reportSaved(report),
  })
  for (const spec of specs) {
    if (!enabled.has(spec.name)) continue
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
