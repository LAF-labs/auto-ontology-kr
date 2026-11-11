import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseCsv, toCsv } from '../src/csv.js'
import { dockerRunArgs } from '../src/docker-args.js'
import { DEFAULT_LIMITS, resolveLimits } from '../src/limits.js'
import { CappedStream } from '../src/runner.js'

describe('csv', () => {
  test('writes nulls as empty cells and quotes what needs quoting', () => {
    const text = toCsv(['a', 'b', 'c'], [[1, null, 'x,y'], ['say "hi"', { k: 1 }, ' pad '], ['line\nbreak', '260.26', true]])
    assert.equal(text, 'a,b,c\n1,,"x,y"\n"say ""hi""","{""k"":1}"," pad "\n"line\nbreak",260.26,true\n')
  })

  test('reads back what it wrote', () => {
    const rows = [['1', '', 'x,y'], ['say "hi"', '{"k":1}', ' pad '], ['line\nbreak', '260.26', 'true']]
    const parsed = parseCsv(toCsv(['a', 'b', 'c'], rows))
    assert.deepEqual(parsed, { columns: ['a', 'b', 'c'], rows, rowCount: 3 })
  })

  test('keeps maxRows rows and still counts all of them', () => {
    const parsed = parseCsv('﻿n\r\n1\r\n2\r\n3\r\n4', { maxRows: 2 })
    assert.deepEqual(parsed, { columns: ['n'], rows: [['1'], ['2']], rowCount: 4 })
  })

  test('an empty file has no columns', () => {
    assert.deepEqual(parseCsv(''), { columns: [], rows: [], rowCount: 0 })
  })
})

describe('limits', () => {
  test('defaults pass and overrides apply', () => {
    assert.deepEqual({ ...resolveLimits() }, { ...DEFAULT_LIMITS })
    assert.equal(resolveLimits({ timeoutS: 5 }).timeoutS, 5)
  })

  test('a single file can never be allowed more than the whole output', () => {
    assert.equal(resolveLimits({ maxOutputBytes: 1000, maxFileBytes: 5000 }).maxFileBytes, 1000)
  })

  test('refuses unknown names and non-positive values', () => {
    assert.throws(() => resolveLimits({ timeout: 5 }), /unknown limit/)
    assert.throws(() => resolveLimits({ timeoutS: 0 }), /positive integer/)
    assert.throws(() => resolveLimits({ memoryMb: 1.5 }), /positive integer/)
    assert.throws(() => resolveLimits({ cpus: 0 }), /positive number/)
  })
})

describe('docker arguments', () => {
  const base = { image: 'img:1', name: 'ae-r1', codeDir: '/d/code', inputDir: '/d/input', outputDir: '/d/output', user: '10001:10001', limits: resolveLimits({ timeoutS: 60, memoryMb: 512, cpus: 0.5 }) }
  const args = dockerRunArgs(base)
  const valueOf = flag => args[args.indexOf(flag) + 1]
  const valuesOf = flag => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : [])

  test('isolates the run', () => {
    assert.equal(valueOf('--network'), 'none')
    assert.equal(valueOf('--user'), '10001:10001')
    assert.equal(valueOf('--cap-drop'), 'ALL')
    assert.equal(valueOf('--security-opt'), 'no-new-privileges')
    assert.equal(valueOf('--pull'), 'never')
    for (const flag of ['--rm', '--read-only']) assert.ok(args.includes(flag), flag)
    for (const flag of ['--privileged', '--cap-add', '-v', '--volume', '--device', '--publish', '-p', '--env-file', '--pid', '--volumes-from']) assert.ok(!args.includes(flag), flag)
  })

  test('mounts code and input read-only and only output writable', () => {
    assert.deepEqual(valuesOf('--mount'), [
      'type=bind,source=/d/code,target=/code,readonly',
      'type=bind,source=/d/input,target=/input,readonly',
      'type=bind,source=/d/output,target=/output',
    ])
    assert.deepEqual(valuesOf('--tmpfs'), ['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'])
  })

  test('applies the limits', () => {
    assert.equal(valueOf('--cpus'), '0.5')
    assert.equal(valueOf('--memory'), '512m')
    assert.equal(valueOf('--memory-swap'), '512m')
    assert.equal(valueOf('--pids-limit'), '128')
    assert.ok(valuesOf('--ulimit').includes(`fsize=${base.limits.maxFileBytes}:${base.limits.maxFileBytes}`))
    // The image and its fixed command come last; the in-container timeout outlasts the host timer.
    assert.deepEqual(args.slice(args.indexOf('img:1')), ['img:1', '--signal', 'KILL', '70', 'python', '-B', '/opt/analysis/entry.py'])
  })

  test('refuses root, option-like images and paths that would add mount options', () => {
    assert.throws(() => dockerRunArgs({ ...base, user: '0:0' }), /non-root/)
    assert.throws(() => dockerRunArgs({ ...base, user: 'root' }), /non-root/)
    assert.throws(() => dockerRunArgs({ ...base, image: '--privileged' }), /image/)
    assert.throws(() => dockerRunArgs({ ...base, name: 'a b' }), /container name/)
    assert.throws(() => dockerRunArgs({ ...base, inputDir: '/d/input,target=/output' }), /absolute path/)
    assert.throws(() => dockerRunArgs({ ...base, outputDir: 'relative' }), /absolute path/)
  })
})

describe('capped stream', () => {
  test('keeps everything under the cap', () => {
    const stream = new CappedStream(100)
    stream.push(Buffer.from('hello '))
    stream.push(Buffer.from('world'))
    assert.deepEqual(stream.result(), { text: 'hello world', bytes: 11, truncated: false })
  })

  test('keeps the head and the tail and reports the cut', () => {
    const stream = new CappedStream(20)
    for (let index = 0; index < 100; index++) stream.push(Buffer.from(`${String(index).padStart(3, '0')}\n`))
    const result = stream.result()
    assert.equal(result.bytes, 400)
    assert.equal(result.truncated, true)
    assert.equal(result.text, '000\n001\n00\n… [380 bytes cut] …\n7\n098\n099\n')
  })
})
