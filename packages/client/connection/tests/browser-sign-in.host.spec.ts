/** Browser sessions started by a sign-in plugin (`signInPath`) instead of the launch token. */

import { describe, expect, it } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end() {},
    },
    state,
  }
}

function request(url: string, cookie?: string, authority = '127.0.0.1:3080'): ConnectionIndexRequest {
  return { method: 'GET', url, headers: { host: authority, ...cookie === undefined ? {} : { cookie } } }
}

function createAuth(signInPath?: string): Promise<BrowserAuth> {
  return BrowserAuth.create({}, new RecordCredentials() as unknown as CredentialProvider, 30, signInPath)
}

function cookiePair(setCookie: string | undefined): string {
  if (setCookie === undefined) throw new Error('no cookie was issued')
  return setCookie.slice(0, setCookie.indexOf(';'))
}

describe('BrowserAuth with a sign-in path', () => {
  it('redirects unauthenticated index requests to the sign-in page and ignores the launch token', async () => {
    const tokenAuth = await createAuth()
    const token = new URL(tokenAuth.authenticatedUrl('http://127.0.0.1:3080/')).searchParams.get('token')
    expect(token).not.toBeNull()

    const auth = await createAuth('/login')
    expect(auth.authenticatedUrl('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/')
    for (const url of ['/', '/index.html', `/?token=${String(token)}`]) {
      const res = response()
      expect(auth.authorizeIndex(request(url), res.value)).toBe(false)
      expect(res.state.status).toBe(303)
      expect(res.state.headers?.location).toBe('./login')
      expect(res.state.headers?.['set-cookie']).toBeUndefined()
    }
  })

  it('refuses the API launch-token exchange', async () => {
    const auth = await createAuth('/login')
    const ownToken = Reflect.get(auth, 'launchToken') as string
    const res = response()
    let published = false
    auth.authorizeConnect(request(`/connect?token=${ownToken}`), res.value, false, () => {
      published = true
      return 'peer' as PeerId
    })
    expect(res.state.status).toBe(401)
    expect(published).toBe(false)
  })

  it('issues an authority-bound session cookie and an expiring one', async () => {
    const auth = await createAuth('/login')
    const issued = auth.issueSession(request('/login'))
    expect(issued).toMatch(/HttpOnly; SameSite=Strict$/u)
    const cookie = cookiePair(issued)
    expect(auth.isAuthenticated(request('/', cookie))).toBe(true)
    expect(auth.authorizeIndex(request('/', cookie), response().value)).toBe(true)
    // Another authority neither reads the cookie name nor accepts the payload.
    expect(auth.isAuthenticated(request('/', cookie, 'other.example:3080'))).toBe(false)
    expect(auth.issueSession(request('/login'), true)).toMatch(/; Secure$/u)

    const expired = auth.expireSession(request('/logout'))
    expect(expired).toContain('Max-Age=0')
    expect(cookiePair(expired).split('=')[0]).toBe(cookie.split('=')[0])
    expect(auth.isAuthenticated(request('/', cookiePair(expired)))).toBe(false)
    expect(auth.issueSession({ headers: {} })).toBeUndefined()
    expect(auth.expireSession({ headers: {} })).toBeUndefined()
  })

  it('keeps the launch-token exchange when no sign-in path is configured', async () => {
    const auth = await createAuth()
    const res = response()
    const url = new URL(auth.authenticatedUrl('http://127.0.0.1:3080/'))
    expect(auth.authorizeIndex(request(`/${url.search}`), res.value)).toBe(false)
    expect(res.state.status).toBe(303)
    expect(res.state.headers?.['set-cookie']).toBeDefined()
    const plain = response()
    expect(auth.authorizeIndex(request('/'), plain.value)).toBe(false)
    expect(plain.state.status).toBe(401)
  })
})
