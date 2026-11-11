/**
 * Developer chrome the shell offers no slot, row or setting to remove, by name.
 * Each value is a CSS selector list hidden with `display: none`. The class
 * parts are CSS-module local names (built as `<hash>_<localName>`), matched by
 * suffix; when upstream renames one, that element shows again and nothing else
 * breaks. Add an entry only after checking it in the running product.
 */
export const HIDES = {}

/** Names of HIDES a configuration does not know, for a load-time error. */
export function unknownHides(names) {
  return names.filter(name => !Object.hasOwn(HIDES, name))
}

/** One stylesheet hiding every listed element. */
export function hideCss(names) {
  return names.map(name => `/* ${name} */ ${HIDES[name]} { display: none !important; }`).join('\n')
}
