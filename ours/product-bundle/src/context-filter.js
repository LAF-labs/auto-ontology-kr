/**
 * `system-prompt/assemble` listener that removes named runtime-context
 * entries after the rest of the waterfall has run. Dependency-free so it can
 * be unit-tested under plain node.
 *
 * Only optional contexts stay removed: the system prompt restores contexts
 * registered as required (for example `working-directory:current`) when it
 * refreshes an accepted assembly.
 * @param {readonly string[]} names - context names to drop.
 * @returns the waterfall listener.
 */
export function createContextFilter(names) {
  const drop = new Set(names)
  return async (_assembly, _context, next) => {
    const assembly = await next()
    if (drop.size === 0) return assembly
    return { ...assembly, contexts: assembly.contexts.filter(entry => !drop.has(entry.name)) }
  }
}
