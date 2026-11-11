/**
 * The /login and /logout request handlers, written against a small `deps`
 * object so they run under node:test without a harness:
 *
 *   deps.rejection(req)      403 for a request that fails the Host/Origin checks, 401 for no session, undefined when signed in
 *   deps.signIn(req)         Set-Cookie value that starts a session, or undefined
 *   deps.signOut(req)        Set-Cookie value that ends this browser's session, or undefined
 *   deps.brand               { name, logoUri }
 *   deps.account             { username, hash } with `hash` from parseHash
 *   deps.limiter             AttemptLimiter
 *   deps.log(line)           one line per refused or failed attempt; never receives the id or the password
 */
import { createHash } from 'node:crypto'
import { COPY, renderLoginPage } from './page.js'
import { sameText, verifyPassword } from './password.js'

const MAX_FORM_BYTES = 8 * 1024

const THEME_SCRIPT_HASH = (() => {
  const page = renderLoginPage({ name: '', logoUri: '' })
  const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'))
  return createHash('sha256').update(script, 'utf8').digest('base64')
})()

// `same-origin`, not `no-referrer`: under `no-referrer` a browser posts the form with
// `Origin: null`, which Connection's Origin check refuses.
const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'sha256-${THEME_SCRIPT_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
}

function redirect(res, location, cookie) {
  res.writeHead(303, {
    'cache-control': 'no-store',
    'location': location,
    'referrer-policy': 'no-referrer',
    ...cookie === undefined ? {} : { 'set-cookie': cookie },
  })
  res.end()
}

function plain(res, status, text, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(text)
}

function page(deps, req, res, status, options, headers = {}) {
  const html = renderLoginPage(deps.brand, options)
  res.writeHead(status, { ...PAGE_HEADERS, ...headers })
  res.end(req.method === 'HEAD' ? undefined : html)
}

/** Read a small urlencoded form; resolves undefined when it is too large or not a form. */
function readForm(req) {
  return new Promise((resolve) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/x-www-form-urlencoded') { req.resume(); resolve(undefined); return }
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    req.on('data', (chunk) => {
      size += chunk.byteLength
      if (size > MAX_FORM_BYTES) { finish(undefined); req.resume(); return }
      if (!done) chunks.push(chunk)
    })
    req.on('end', () => { finish(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) })
    req.on('error', () => { finish(undefined) })
  })
}

function clientKey(req) {
  return req.socket?.remoteAddress ?? 'unknown'
}

/** Build the handler for `/login` (GET and HEAD show the page, POST checks the form). */
export function loginHandler(deps) {
  return async (req, res) => {
    const rejection = deps.rejection(req)
    if (rejection === 403) { plain(res, 403, 'forbidden\n'); return }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (rejection === undefined) { redirect(res, './'); return }
      const query = new URL(req.url ?? '/login', 'http://login.invalid').searchParams
      const notice = query.has('out') ? { kind: 'info', text: COPY.signedOut }
        : query.has('expired') ? { kind: 'info', text: COPY.expired } : undefined
      page(deps, req, res, 200, { notice })
      return
    }
    if (req.method !== 'POST') { plain(res, 405, 'method not allowed\n', { allow: 'GET, HEAD, POST' }); return }

    const key = clientKey(req)
    const wait = deps.limiter.retryAfterMs(key)
    if (wait > 0) {
      req.resume()
      deps.log(`sign-in refused for ${key}: attempt limit`)
      const seconds = Math.ceil(wait / 1000)
      page(deps, req, res, 429, { notice: { kind: 'error', text: COPY.limited(Math.ceil(seconds / 60)) } }, { 'retry-after': String(seconds) })
      return
    }
    const form = await readForm(req)
    if (form === undefined) { plain(res, 400, 'bad request\n'); return }
    const username = form.get('username') ?? ''
    const password = form.get('password') ?? ''
    // The password check always runs, so a wrong id and a wrong password take the same time.
    const passwordOk = await verifyPassword(password, deps.account.hash)
    const usernameOk = sameText(username, deps.account.username)
    if (!(passwordOk && usernameOk)) {
      deps.limiter.fail(key)
      deps.log(`sign-in failed for ${key}`)
      page(deps, req, res, 401, { notice: { kind: 'error', text: COPY.invalid }, username: username.slice(0, 128) })
      return
    }
    const cookie = deps.signIn(req)
    if (cookie === undefined) { plain(res, 403, 'forbidden\n'); return }
    deps.limiter.succeed(key)
    redirect(res, './', cookie)
  }
}

/** Build the handler for `/logout` (POST only; the session cookie is `SameSite=Strict`). */
export function logoutHandler(deps) {
  return (req, res) => {
    req.resume()
    if (deps.rejection(req) === 403) { plain(res, 403, 'forbidden\n'); return }
    if (req.method !== 'POST') { plain(res, 405, 'method not allowed\n', { allow: 'POST' }); return }
    redirect(res, './login?out', deps.signOut(req))
  }
}
