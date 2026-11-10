import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequestGuard } from '../src/guard.js'

function mount(config) {
  let listener
  listener = createRequestGuard(config.denyPathPrefixes)
  return async (url) => {
    const response = { status: undefined, writeHead(status) { this.status = status }, end() {} }
    let passed = false
    await listener({ url }, response, async () => { passed = true })
    return passed ? 'next' : response.status
  }
}

test('refuses denied prefixes after URL normalization', async () => {
  const run = mount({ denyPathPrefixes: ['/api/pluginManager/'] })
  assert.equal(await run('/api/pluginManager/listBundles'), 403)
  assert.equal(await run('/api/./pluginManager/installBundle'), 403)
  assert.equal(await run('/api/x/../pluginManager/installBundle?y=1'), 403)
  assert.equal(await run('/api/session/prompt'), 'next')
  assert.equal(await run('/api/ao/run'), 'next')
})

test('prefixes outside /api fail at load', () => {
  assert.throws(() => mount({ denyPathPrefixes: ['/plugin'] }), /must start with \/api\//)
})
