/**
 * Host half of the customer shell: checks the configured `hide` names and
 * hands the stylesheet to the page (`__OURS_CUSTOMER_SHELL__`). The display
 * defaults and row switches of this bundle live in cordis.patch.yml.
 */
import z from '@deepseek-ai/schemastery'
import { HIDES, hideCss, unknownHides } from './src/hides.js'

export const name = 'customer-shell'
export const inject = ['webServer']

export const Config = z.object({
  hide: z.array(z.string()).default([]).description(`Developer chrome to hide: ${Object.keys(HIDES).join(', ')}.`),
})

export function apply(ctx, config) {
  const unknown = unknownHides(config.hide)
  if (unknown.length > 0) throw new Error(`customer-shell: unknown hide name(s) ${unknown.join(', ')}; known: ${Object.keys(HIDES).join(', ')}`)
  const css = hideCss(config.hide)
  ctx.on('webserver/index-inject', (table) => {
    if (css !== '') table.push({ kind: 'style', text: css })
  })
}
