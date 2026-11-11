/**
 * Sign-in for the one company account.
 *
 *   GET  /login    the sign-in page (signed-in browsers go to the application)
 *   POST /login    username + password form; on success the harness's signed browser cookie
 *   POST /logout   clears this browser's cookie
 *   GET  /api/companyLogin/session   { username } for a signed-in browser, 401 otherwise
 *
 * The session is the Connection service's existing signed cookie; this package
 * keeps no session table. It needs the Connection row's `signInPath` switch
 * (PATCHES.md section 5), which this bundle's patch sets to /login: with it,
 * the launch token is accepted nowhere and unauthenticated page requests are
 * redirected here.
 *
 * More than one account later: replace `account` below with a lookup and put
 * the account id in the cookie payload (packages/client/connection/src/browser-auth.ts,
 * BrowserCookiePayload and issueSession); every browser still shares the one owner Peer.
 */
import z from '@deepseek-ai/schemastery'
import { loginHandler, logoutHandler } from './src/handlers.js'
import { AttemptLimiter } from './src/limiter.js'
import { parseHash } from './src/password.js'

export const name = 'company-login'
export const inject = ['webServer', 'connection', 'productBrand']

export const Config = z.object({
  username: z.string().required().description('Account id of the one company account.'),
  passwordHash: z.string().required().description('scrypt hash written by bin/hash-password.mjs. Never the password.'),
  maxFailures: z.natural().min(1).default(5).description('Failed attempts from one client address before it is refused until the window ends.'),
  globalMaxFailures: z.natural().min(1).default(50).description('Failed attempts from all addresses together before every attempt is refused until the window ends.'),
  windowMinutes: z.natural().min(1).default(10).description('Length of the attempt window.'),
})

export function apply(ctx, config) {
  const username = config.username.trim()
  if (username === '') throw new Error('company-login: username is empty (COMPANY_LOGIN_USERNAME)')
  let hash
  try {
    hash = parseHash(config.passwordHash)
  } catch (error) {
    throw new Error(`company-login: ${error.message} (COMPANY_LOGIN_PASSWORD_HASH)`)
  }

  const deps = {
    rejection: req => ctx.connection.requestRejection(req),
    signIn: req => ctx.connection.signIn(req),
    signOut: req => ctx.connection.signOut(req),
    brand: { name: ctx.productBrand.name, logoUri: ctx.productBrand.logoUri },
    account: { username, hash },
    limiter: new AttemptLimiter({
      maxFailures: config.maxFailures,
      globalMaxFailures: config.globalMaxFailures,
      windowMs: config.windowMinutes * 60 * 1000,
    }),
    // The web profile mounts no console logger, so write the audit line to stderr as web-app does for its URL line.
    log: (line) => { console.warn(`company-login: ${new Date().toISOString()} ${line}`) },
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/login', handler: loginHandler(deps) }), 'company-login: /login')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/logout', handler: logoutHandler(deps) }), 'company-login: /logout')
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/companyLogin/session',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(Response.json({ username }, { headers: { 'cache-control': 'no-store' } })),
    })
    return () => dispose()
  }, 'company-login: session route')
}
