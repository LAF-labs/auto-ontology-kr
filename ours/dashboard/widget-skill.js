/**
 * The `dashboard-widget-authoring` skill, registered into the layer of the
 * preset that mounts this row (the dashboard editor), so other agents do not
 * see it. The body is skills/dashboard-widget-authoring.md.
 */
import { readFileSync } from 'node:fs'

export const name = 'dashboard-widget-skill'
export const inject = ['skills']

const content = readFileSync(new URL('./skills/dashboard-widget-authoring.md', import.meta.url), 'utf8')

export function apply(ctx) {
  ctx.effect(() => ctx.skills.register({
    name: 'dashboard-widget-authoring',
    description: 'How to write a new dashboard widget type: the module contract, props, theme values, what is forbidden, and the order of checks before saving.',
    whenToUse: 'Before calling dashboard_save_widget_type.',
    source: 'runtime',
    content,
  }), 'dashboard-widget-skill')
}
