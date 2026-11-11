/**
 * Browser half of the product brand: fills the sidebar and new-session brand
 * slots and makes the window title use the product name in every language.
 *
 * The shell builds the window title from the `common` dictionary key
 * `brand.localBuild`, and a (namespace, locale) dictionary has one owner, so
 * the name cannot be registered over it. This plugin replaces that one entry
 * in each loaded `common` dictionary instead (the registry is a plain Map on
 * the locale service). If a later upstream version changes the registry, the
 * title falls back to the upstream text and the sidebar still shows the name.
 */
window.__ModuleLoader__.load({
  id: '@ours/brand',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const brand = globalThis.__OURS_BRAND__ ?? { name: '', logoUri: '' }
    const TITLE_KEY = 'brand.localBuild'

    function Mark(props) {
      const size = props.size ?? 24
      return h('img', { src: brand.logoUri, width: size, height: size, alt: '', draggable: false, style: { display: 'block' } })
    }

    function Name() {
      return h('span', {
        title: brand.name,
        style: { font: 'var(--dsw-font-md-16-strong, 600 16px/24px sans-serif)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, brand.name)
    }

    function nameTitleKey(locale) {
      const common = locale.dicts instanceof Map ? locale.dicts.get('common') : undefined
      if (!(common instanceof Map)) return
      for (const [id, dict] of common) {
        if (dict[TITLE_KEY] !== brand.name) common.set(id, { ...dict, [TITLE_KEY]: brand.name })
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (!brand.name) return
        ctx.slots.inject('sidebar.brand.mark', () =>
          ctx.slots.inject('sidebar.brand.name', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark' }, Mark)
            yield ctx.slots.register({ name: 'sidebar.brand.name' }, Name)
          }))
        ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Mark))
        // The new-session headline carries an upstream "Preview" badge with no slot or switch. Its class
        // is a CSS-module name ending in `_previewBadge`; if a build names it differently the badge shows.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = '[class*="_previewBadge"] { display: none !important; }'
          document.head.append(style)
          return () => { style.remove() }
        }, 'brand: hide the preview badge')
        // Language packs register `common` dictionaries after this plugin; redo the entry on each change.
        nameTitleKey(ctx.locale)
        ctx.effect(() => ctx.locale.subscribe(() => { nameTitleKey(ctx.locale) }), 'brand: product name in the window title')
        // A dictionary registration republishes the snapshot, so mounted outlets read the replaced entry.
        ctx.effect(() => ctx.locale.register('ours.brand', 'en', { name: brand.name }), 'brand: dictionary')
      },
    }
  },
})
