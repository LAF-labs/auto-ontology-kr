import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkDictionaries, missingKeys } from '../src/check.mjs'

const read = name => JSON.parse(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))

test('ko.json matches the English snapshot: same keys, same placeholders', () => {
  const ko = read('ko.json')
  const en = read('en.snapshot.json')
  assert.deepEqual(checkDictionaries(ko, en), [])
  assert.deepEqual(missingKeys(ko, en), [])
})

test('client.js embeds the current ko.json', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const ko = read('ko.json')
  assert.ok(client.includes(JSON.stringify(ko.sidebar['session.new'])))
  assert.ok(client.includes(JSON.stringify(ko.conversation['placeholder.default'])), 'run node build.mjs after editing src/ko.json')
})

test('the check reports a changed placeholder and an unknown key', () => {
  const en = { a: { greet: 'Hello {name}' } }
  assert.equal(checkDictionaries({ a: { greet: '안녕하세요 {이름}' } }, en).length, 1)
  assert.equal(checkDictionaries({ a: { greeet: '안녕하세요' } }, en).length, 1)
  assert.deepEqual(missingKeys({ a: {} }, en), ['a: greet'])
})
