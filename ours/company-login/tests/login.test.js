import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { loginHandler, logoutHandler } from '../src/handlers.js'
import { AttemptLimiter } from '../src/limiter.js'
import { renderLoginPage } from '../src/page.js'
import { hashPassword, parseHash, sameText, verifyPassword } from '../src/password.js'

const GOOD = 'correct horse battery'
const account = { username: 'acme', hash: parseHash(await hashPassword(GOOD)) }

function request(method, url, form, address = '10.0.0.1') {
  const body = form === undefined ? [] : [Buffer.from(new URLSearchParams(form).toString())]
  const req = Readable.from(body)
  req.method = method
  req.url = url
  req.headers = form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }
  Object.defineProperty(req, 'socket', { value: { remoteAddress: address } })
  return req
}

function response() {
  const res = { status: undefined, headers: {}, body: undefined, done: undefined }
  res.done = new Promise((resolve) => {
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? {} }
    res.end = (body) => { res.body = body; resolve(res) }
  })
  return res
}

function deps(overrides = {}) {
  const log = []
  return {
    log,
    rejection: () => 401,
    signIn: () => 'dsh-auth-x=signed; HttpOnly',
    signOut: () => 'dsh-auth-x=; Max-Age=0',
    brand: { name: 'Acme <Desk>', logoUri: 'data:image/svg+xml;base64,AAAA' },
    account,
    limiter: new AttemptLimiter({ maxFailures: 3, globalMaxFailures: 100, windowMs: 60000 }),
    ...overrides,
    log: line => log.push(line),
    lines: log,
  }
}

async function run(handler, req) {
  const res = response()
  await handler(req, res)
  return res.done
}

test('password hashes verify, differ per call, and reject malformed stored values', async () => {
  const a = await hashPassword(GOOD)
  const b = await hashPassword(GOOD)
  assert.notEqual(a, b)
  assert.equal(await verifyPassword(GOOD, parseHash(a)), true)
  assert.equal(await verifyPassword('correct horse batterx', parseHash(a)), false)
  assert.equal(await verifyPassword('', parseHash(a)), false)
  await assert.rejects(hashPassword('short'), /at least 8/)
  for (const bad of ['', GOOD, 'scrypt:3:8:1:aaaa:bbbb', 'scrypt:1073741824:8:1:aaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbb', 'bcrypt:1:1:1:a:b']) {
    assert.throws(() => parseHash(bad), (error) => !error.message.includes(GOOD))
  }
  assert.equal(sameText('acme', 'acme'), true)
  assert.equal(sameText('acme', 'acme2'), false)
})

test('GET shows the page to a signed-out browser and sends a signed-in one to the application', async () => {
  const shown = await run(loginHandler(deps()), request('GET', '/login'))
  assert.equal(shown.status, 200)
  assert.match(shown.body, /Acme &lt;Desk&gt;/)
  assert.match(shown.body, /--dsw-alias-button-primary-fill/)
  assert.doesNotMatch(shown.body, /<link rel="stylesheet"/)
  assert.match(shown.headers['content-security-policy'], /frame-ancestors 'none'/)
  const signedIn = await run(loginHandler(deps({ rejection: () => undefined })), request('GET', '/login'))
  assert.equal(signedIn.status, 303)
  assert.equal(signedIn.headers.location, './')
  const untrusted = await run(loginHandler(deps({ rejection: () => 403 })), request('GET', '/login'))
  assert.equal(untrusted.status, 403)
})

test('POST with the right id and password sets the session cookie and redirects', async () => {
  const d = deps()
  const res = await run(loginHandler(d), request('POST', '/login', { username: 'acme', password: GOOD }))
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, './')
  assert.match(res.headers['set-cookie'], /^dsh-auth-x=signed/)
  assert.deepEqual(d.lines, [])
})

test('POST with a wrong id or password shows one message, sets no cookie, and never logs the password', async () => {
  const d = deps()
  for (const form of [{ username: 'acme', password: 'wrong password' }, { username: 'other', password: GOOD }]) {
    const res = await run(loginHandler(d), request('POST', '/login', form))
    assert.equal(res.status, 401)
    assert.equal(res.headers['set-cookie'], undefined)
    assert.match(res.body, /아이디 또는 비밀번호가 맞지 않습니다/)
    assert.doesNotMatch(res.body, /wrong password|correct horse/)
  }
  assert.equal(d.lines.length, 2)
  assert.ok(d.lines.every(line => !line.includes('wrong') && !line.includes(GOOD)))
})

test('after the failure limit even the right password is refused until the window ends', async () => {
  let now = 1000
  const limiter = new AttemptLimiter({ maxFailures: 3, globalMaxFailures: 100, windowMs: 60000, now: () => now })
  const d = deps({ limiter })
  const handler = loginHandler(d)
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await run(handler, request('POST', '/login', { username: 'acme', password: 'nope nope' }))).status, 401)
  }
  const limited = await run(handler, request('POST', '/login', { username: 'acme', password: GOOD }))
  assert.equal(limited.status, 429)
  assert.equal(limited.headers['retry-after'], '60')
  assert.equal(limited.headers['set-cookie'], undefined)
  // Another address is not locked out by the first one.
  assert.equal((await run(handler, request('POST', '/login', { username: 'acme', password: GOOD }, '10.0.0.2'))).status, 303)
  now += 60001
  assert.equal((await run(handler, request('POST', '/login', { username: 'acme', password: GOOD }))).status, 303)
})

test('the shared bucket limits attempts spread over many addresses', () => {
  const limiter = new AttemptLimiter({ maxFailures: 5, globalMaxFailures: 4, windowMs: 1000, now: () => 0 })
  for (let i = 0; i < 4; i += 1) limiter.fail(`10.0.0.${i}`)
  assert.equal(limiter.retryAfterMs('10.9.9.9'), 1000)
})

test('non-form and oversized bodies are refused', async () => {
  const d = deps()
  const json = request('POST', '/login', { username: 'acme', password: GOOD })
  json.headers = { 'content-type': 'application/json' }
  assert.equal((await run(loginHandler(d), json)).status, 400)
  const big = request('POST', '/login', { username: 'acme', password: 'x'.repeat(9000) })
  assert.equal((await run(loginHandler(d), big)).status, 400)
  assert.equal((await run(loginHandler(d), request('PUT', '/login'))).status, 405)
})

test('logout is POST only and clears the cookie', async () => {
  const res = await run(logoutHandler(deps()), request('POST', '/logout'))
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, './login?out')
  assert.match(res.headers['set-cookie'], /Max-Age=0/)
  assert.equal((await run(logoutHandler(deps()), request('GET', '/logout'))).status, 405)
  assert.equal((await run(logoutHandler(deps({ rejection: () => 403 })), request('POST', '/logout'))).status, 403)
})

test('page escapes the refilled id and the brand name', () => {
  const html = renderLoginPage({ name: '<b>A</b>', logoUri: 'data:x' }, { username: '"><script>alert(1)</script>' })
  assert.doesNotMatch(html, /<script>alert/)
  assert.doesNotMatch(html, /<b>A<\/b>/)
})
