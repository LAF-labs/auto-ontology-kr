/**
 * Seeds the basic widget modules (widgets.json) into the dashboard store at
 * startup. Each module version is immutable: an existing identical version is
 * left alone, and a changed file under an existing version is refused and
 * logged, so a changed widget ships as a new version number. They are stored
 * with origin `basic`: reviewed code the runtime mounts in the page, unlike
 * generated widgets, which run in a sandboxed frame.
 */
import { readFile } from 'node:fs/promises'

export const name = 'widgets-basic'
export const inject = ['dashboardStore']

export async function apply(ctx) {
  const manifest = JSON.parse(await readFile(new URL('./widgets.json', import.meta.url), 'utf8'))
  for (const entry of manifest.widgets) {
    const source = await readFile(new URL(entry.file, import.meta.url), 'utf8')
    try {
      const result = await ctx.dashboardStore.putWidget({ type: entry.type, version: entry.version, source, description: entry.description, origin: 'basic' })
      if (result.created) ctx.logger.info(`widgets-basic: seeded ${entry.type}@${entry.version}`)
    } catch (error) {
      ctx.logger.warn(`widgets-basic: kept stored ${entry.type}@${entry.version}: ${error.message}`)
    }
  }
}
