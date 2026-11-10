import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContextFilter } from '../src/context-filter.js'

test('drops named contexts after the rest of the waterfall', async () => {
  const listener = createContextFilter(['sandbox:policy', 'approval:policy'])
  const assembly = { sections: [], variables: {}, contexts: [
    { name: 'working-directory:current', text: 'cwd' },
    { name: 'sandbox:policy', text: 'policy' },
    { name: 'time:now', text: 'time' },
    { name: 'approval:policy', text: 'ask' },
  ] }
  let calledNext = false
  const result = await listener(assembly, {}, async () => { calledNext = true; return assembly })
  assert.equal(calledNext, true)
  assert.deepEqual(result.contexts.map(entry => entry.name), ['working-directory:current', 'time:now'])
  assert.equal(assembly.contexts.length, 4)
})

test('empty list passes the assembly through', async () => {
  const assembly = { contexts: [{ name: 'a' }] }
  assert.equal(await createContextFilter([])(assembly, {}, async () => assembly), assembly)
})
