/**
 * Developer chrome the shell offers no slot, row or setting to remove, by name.
 * Each value is a CSS selector list hidden with `display: none`. The class
 * parts are CSS-module local names (built as `<hash>_<localName>`), matched by
 * suffix; when upstream renames one, that element shows again and nothing else
 * breaks. Add an entry only after checking it in the running product.
 */
export const HIDES = {
  // Sidebar head: "add workspace" (P0-1). Search and view options stay.
  'workspace-add': 'button:has(svg[data-icon="dsw-icon-project-add-outline-regular"])',
  // Sidebar hover card: the working-directory path under a conversation title.
  'session-path': '[class*="_hoverContent"] > [class*="_hoverPath"]',
  // New question: the workspace and agent-preset pickers (one choice each) and the
  // composer "+" (attachments are off; commands are not for customers) (P0-2).
  'composer-workspace': 'button[class*="_workspace"]:has(svg[data-icon="dsw-icon-folder-open-regular"])',
  'composer-preset': '[class*="_seat"]:has(svg[data-icon="dsw-icon-agent-preset-outline-regular"])',
  'composer-add': 'button[class*="_add"]:has(svg[data-icon="dsw-icon-plus-outline-medium"])',
  // Conversation header: the agent-preset label ("Analyst") (P0-3).
  'header-preset': '[data-slot="conversation.session.header.actions"] > span:has(svg[data-icon="dsw-icon-agent-preset-outline-regular"])',
  // Under the composer: tokens per second, cache hits and the context ring (P0-3).
  'composer-stats': '[data-slot="conversation.composer.dock"], [class*="_dock"] > span:has(> button circle)',
  // Reasoning rows with the model's raw thinking (P0-3). Work progress still shows.
  'reasoning': '[class*="_root"]:has(> [class*="_root"] > [class*="_header"] > [class*="_row"] svg[data-icon="dsw-icon-think-outline-regular"])',
}

/** Names of HIDES a configuration does not know, for a load-time error. */
export function unknownHides(names) {
  return names.filter(name => !Object.hasOwn(HIDES, name))
}

/** One stylesheet hiding every listed element. */
export function hideCss(names) {
  return names.map(name => `/* ${name} */ ${HIDES[name]} { display: none !important; }`).join('\n')
}
