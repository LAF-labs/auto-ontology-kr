/**
 * Client half of the runtime spike.
 * b: registers a `main` panel keyed `ours-dashboard`, a sidebar entry, and selects it at start.
 * c/e: exposes probes on window.__oursSpike for manual runs from the page.
 */
window.__ModuleLoader__.load({
  id: '@ours/spike',
  factory(require) {
    window.__oursSpikeRequire = require
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'ours-dashboard'
    const state = { events: [] }
    const note = (event) => { state.events.push({ at: Date.now(), event }); console.info('[ours-spike]', event) }
    function Dashboard() {
      return h('div', { style: { padding: 24 } },
        h('h2', null, 'ours-spike dashboard'),
        h('p', null, 'First-panel experiment. Open a session to compare the conversation state.'))
    }
    function Icon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2, fill: 'currentColor' }))
    }
    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        window.__oursSpike = {
          state,
          ctx,
          selectDashboard: () => ctx.layout.selectPanel(PANEL_ID),
          panel: () => ctx.layout.panelInfo.getSnapshot(),
          async fetchJson(path, init) {
            const response = await fetch(path, init)
            const text = await response.text()
            return { status: response.status, body: text.slice(0, 2000) }
          },
          async rpc(endpoint, payload) {
            const body = { type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }
            return await window.__oursSpike.fetchJson('api/' + endpoint, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            })
          },
          async mount(specifier) {
            try {
              const contribution = require(specifier)
              const dispose = await ctx.get("remote").$mount(contribution.default ?? contribution)
              return { ok: true, dispose }
            } catch (error) {
              return { ok: false, error: String(error) }
            }
          },
        }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Dashboard))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: -100, label: () => 'Dashboard',
        }, Icon))
        const unsubscribe = ctx.layout.panelInfo.subscribe(() => note({ panel: ctx.layout.panelInfo.getSnapshot() }))
        ctx.effect(() => unsubscribe)
        note({ before: ctx.layout.panelInfo.getSnapshot() })
        ctx.layout.selectPanel(PANEL_ID)
        note({ after: ctx.layout.panelInfo.getSnapshot() })
      },
    }
  },
})
