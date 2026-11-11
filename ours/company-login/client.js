/**
 * Browser half of the company sign-in: a sign-out button in the sidebar foot
 * (above Settings), and a return to the sign-in page when the session ends
 * while the application is open (checked when the window regains focus and
 * once a minute). With the host row off the session route is absent and
 * nothing is shown.
 */
window.__ModuleLoader__.load({
  id: '@ours/company-login',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'ours.companyLogin'
    const SESSION_URL = 'api/companyLogin/session'
    const CHECK_MS = 60000
    const COPY = {
      en: { signOut: 'Sign out' },
      ko: { signOut: '로그아웃' },
    }
    const state = { active: false, username: '', listeners: new Set() }
    const subscribe = (fn) => { state.listeners.add(fn); return () => state.listeners.delete(fn) }
    const isActive = () => state.active

    function Icon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3' }),
        h('path', { d: 'M10.5 5 13.5 8l-3 3M13.5 8h-7' }))
    }

    // No confirmation: signing back in is one form, and nothing unsaved lives only in the page.
    function signOut() {
      const form = document.createElement('form')
      form.method = 'post'
      form.action = 'logout'
      document.body.append(form)
      form.submit()
    }

    function SignOutButton(props) {
      const active = React.useSyncExternalStore(subscribe, isActive)
      const [hover, setHover] = React.useState(false)
      if (!active) return null
      const text = props.t('signOut')
      const wide = props.wide !== false
      return h('button', {
        type: 'button',
        title: state.username ? `${text} (${state.username})` : text,
        'aria-label': text,
        onClick: signOut,
        onMouseEnter: () => { setHover(true) },
        onMouseLeave: () => { setHover(false) },
        style: {
          display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box',
          width: wide ? '100%' : 32, height: 32, padding: wide ? '0 8px' : 0, justifyContent: wide ? 'flex-start' : 'center',
          border: 'none', borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 14, lineHeight: '22px', whiteSpace: 'nowrap', overflow: 'hidden',
        },
      }, h(Icon), wide ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, text) : null)
    }

    async function check() {
      try {
        const response = await fetch(SESSION_URL, { cache: 'no-store', credentials: 'same-origin' })
        if (response.status === 401) location.replace('login?expired')
        return response
      } catch {
        // Offline or the server is restarting: the shell's own connection indicator reports it.
        return undefined
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', COPY.en), 'company-login: en dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'ko', COPY.ko), 'company-login: ko dictionary')
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'ours-sign-out', order: 100, locale: NS,
        }, SignOutButton))
        const timer = setInterval(() => { if (state.active) void check() }, CHECK_MS)
        const onFocus = () => { if (state.active) void check() }
        window.addEventListener('focus', onFocus)
        ctx.effect(() => () => { clearInterval(timer); window.removeEventListener('focus', onFocus) }, 'company-login: session check')
        void check().then(async (response) => {
          if (response === undefined || !response.ok) return
          const body = await response.json().catch(() => ({}))
          state.username = typeof body.username === 'string' ? body.username : ''
          state.active = true
          for (const fn of state.listeners) fn()
        })
      },
    }
  },
})
