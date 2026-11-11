import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HIDES, hideCss, unknownHides } from '../src/hides.js'

test('unknown hide names are reported and known ones become display:none rules', () => {
  assert.deepEqual(unknownHides(['no-such-element']), ['no-such-element'])
  assert.deepEqual(unknownHides(Object.keys(HIDES)), [])
  assert.equal(hideCss([]), '')
  for (const name of Object.keys(HIDES)) assert.match(hideCss([name]), /display: none !important/)
})
