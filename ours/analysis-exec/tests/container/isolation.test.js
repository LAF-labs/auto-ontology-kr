/**
 * Isolation and limit checks against the real container runtime and image.
 * Run with `npm run test:container` on a host where `docker` answers and
 * `ours-analysis-exec:0.1` is built; every test is skipped otherwise.
 *
 * ANALYSIS_EXEC_PROBE_PORTS lists host TCP ports that must be unreachable from
 * a run (for example the gateway and the database of a running stack).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { resolveLimits } from '../../src/limits.js'
import { ContainerRunner } from '../../src/runner.js'

const IMAGE = process.env.ANALYSIS_EXEC_IMAGE ?? 'ours-analysis-exec:0.1'
const PROBE_PORTS = (process.env.ANALYSIS_EXEC_PROBE_PORTS ?? '').split(',').map(Number).filter(port => Number.isInteger(port) && port > 0)

let root
let counter = 0
const probe = await new ContainerRunner({ image: IMAGE, limits: resolveLimits() }).probe()
const skip = probe.ok ? false : `container runtime or image unavailable: ${probe.message}`

function runner(limits = {}) {
  return new ContainerRunner({ image: IMAGE, limits: resolveLimits({ timeoutS: 30, ...limits }) })
}

async function execute(code, { limits, input = { 'data.csv': 'month,value\n2026-01,10\n' }, signal } = {}) {
  counter += 1
  const dir = join(root, `run${counter}`)
  const dirs = { codeDir: join(dir, 'code'), inputDir: join(dir, 'input'), outputDir: join(dir, 'output') }
  for (const path of Object.values(dirs)) await mkdir(path, { recursive: true })
  await chmod(dirs.outputDir, 0o777)
  await writeFile(join(dirs.codeDir, 'main.py'), code)
  for (const [name, text] of Object.entries(input)) await writeFile(join(dirs.inputDir, name), text)
  const name = `ae-test-${process.pid}-${counter}`
  const result = await runner(limits).run({ name, ...dirs, signal })
  return { ...result, name, ...dirs }
}

function containerExists(name) {
  return execFileSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8' }).trim() !== ''
}

describe('analysis container', { skip }, () => {
  before(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'analysis-exec-'))) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  test('a script reads its input, writes output and is removed afterwards', async () => {
    const result = await execute([
      'import json, pandas as pd',
      'frame = pd.read_csv("/input/data.csv")',
      'json.dump({"rows": len(frame), "total": int(frame["value"].sum())}, open("result.json", "w"))',
      'print("done", len(frame))',
    ].join('\n'))
    assert.equal(result.status, 'ok', result.stderr.text)
    assert.equal(result.stdout.text.trim(), 'done 1')
    assert.deepEqual(JSON.parse(await readFile(join(result.outputDir, 'result.json'), 'utf8')), { rows: 1, total: 10 })
    assert.equal(containerExists(result.name), false)
  })

  test('there is no network: nothing reachable, no DNS, no route, only loopback up', async () => {
    const targets = [
      ['host.docker.internal', 80], ['1.1.1.1', 53], ['8.8.8.8', 443], ['172.17.0.1', 80], ['192.168.65.254', 80],
      ...PROBE_PORTS.flatMap(port => [['host.docker.internal', port], ['172.17.0.1', port], ['192.168.65.254', port], ['127.0.0.1', port]]),
    ]
    const result = await execute([
      'import json, os, socket',
      `targets = ${JSON.stringify(targets)}`,
      'reached = []',
      'for host, port in targets:',
      '    try:',
      '        socket.create_connection((host, port), timeout=2).close()',
      '        reached.append([host, port])',
      '    except OSError:',
      '        pass',
      'resolved = []',
      'for host in ["example.com", "host.docker.internal", "gateway.docker.internal"]:',
      '    try:',
      '        resolved.append([host, socket.gethostbyname(host)])',
      '    except OSError:',
      '        pass',
      // Interfaces that are up (IFF_UP), and IPv4 routes. The kernel lists unconfigured tunnel devices in every namespace.
      'up = sorted(name for name in os.listdir("/sys/class/net") if os.path.isfile(f"/sys/class/net/{name}/flags") and int(open(f"/sys/class/net/{name}/flags").read(), 16) & 1)',
      'routes = open("/proc/net/route").read().splitlines()[1:]',
      'print(json.dumps({"reached": reached, "resolved": resolved, "up": up, "routes": routes}))',
    ].join('\n'))
    assert.equal(result.status, 'ok', result.stderr.text)
    assert.deepEqual(JSON.parse(result.stdout.text), { reached: [], resolved: [], up: ['lo'], routes: [] })
  })

  test('input and code are read-only; nothing outside /output and /tmp is writable', async () => {
    const result = await execute([
      'import json, os',
      'outcome = {}',
      'def attempt(label, action):',
      '    try:',
      '        action()',
      '        outcome[label] = "done"',
      '    except OSError as error:',
      '        outcome[label] = error.__class__.__name__',
      'attempt("append_input", lambda: open("/input/data.csv", "a").write("x"))',
      'attempt("new_input", lambda: open("/input/new.csv", "w").write("x"))',
      'attempt("remove_input", lambda: os.remove("/input/data.csv"))',
      'attempt("chmod_input", lambda: os.chmod("/input/data.csv", 0o666))',
      'attempt("rewrite_code", lambda: open("/code/main.py", "w").write("x"))',
      'for path in ["/", "/opt/analysis", "/etc", "/usr/local/lib", "/home", "/var/tmp", "/root", "/input", "/code"]:',
      '    attempt("write " + path, lambda: open(os.path.join(path, "probe"), "w").write("x"))',
      'attempt("write /tmp", lambda: open("/tmp/probe", "w").write("x"))',
      'attempt("write /output", lambda: open("/output/probe.txt", "w").write("x"))',
      'status = dict(line.split(":\\t") for line in open("/proc/self/status").read().splitlines() if ":\\t" in line)',
      'print(json.dumps({"outcome": outcome, "uid": os.getuid(), "gid": os.getgid(), "cap_eff": status["CapEff"], "no_new_privs": status["NoNewPrivs"]}))',
    ].join('\n'))
    assert.equal(result.status, 'ok', result.stderr.text)
    const report = JSON.parse(result.stdout.text)
    const done = Object.entries(report.outcome).filter(([, value]) => value === 'done').map(([key]) => key)
    assert.deepEqual(done, ['write /tmp', 'write /output'])
    assert.equal(report.uid, 10001)
    assert.equal(report.gid, 10001)
    assert.equal(report.cap_eff, '0000000000000000')
    assert.equal(report.no_new_privs, '1')
    assert.equal(await readFile(join(result.inputDir, 'data.csv'), 'utf8'), 'month,value\n2026-01,10\n')
    assert.deepEqual(await readdir(result.inputDir), ['data.csv'])
    assert.deepEqual(await readdir(result.outputDir), ['probe.txt'])
  })

  test('a run past the time limit is killed and removed', async () => {
    const result = await execute('import time\nprint("start", flush=True)\ntime.sleep(120)\n', { limits: { timeoutS: 3 } })
    assert.equal(result.status, 'timeout')
    assert.ok(result.durationMs < 15000, `took ${result.durationMs} ms`)
    assert.equal(result.stdout.text.trim(), 'start')
    assert.equal(containerExists(result.name), false)
  })

  test('a run past the memory limit is killed', async () => {
    const result = await execute('blocks = []\nwhile True:\n    blocks.append(bytearray(16 * 1024 * 1024))\n', { limits: { memoryMb: 128 } })
    assert.equal(result.status, 'killed')
    assert.equal(result.exitCode, 137)
  })

  test('one file cannot exceed the file size limit', async () => {
    const result = await execute([
      'try:',
      '    with open("/output/big.bin", "wb") as handle:',
      '        for _ in range(8):',
      '            handle.write(bytes(1024 * 1024))',
      '    print("written")',
      'except OSError as error:',
      '    print("refused", error.errno)',
    ].join('\n'), { limits: { maxFileBytes: 2 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024 } })
    assert.equal(result.status, 'ok', result.stderr.text)
    assert.equal(result.stdout.text.trim(), 'refused 27')
    assert.ok(result.output.bytes <= 2 * 1024 * 1024)
  })

  test('a run that fills the output directory is killed', async () => {
    const result = await execute([
      'import time',
      'for index in range(200):',
      '    open(f"/output/part{index}.bin", "wb").write(bytes(1024 * 1024))',
      '    time.sleep(0.05)',
    ].join('\n'), { limits: { maxFileBytes: 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxOutputFiles: 1000 } })
    assert.equal(result.status, 'output_limit')
    assert.ok(result.output.bytes < 64 * 1024 * 1024, `left ${result.output.bytes} bytes`)
  })

  test('a run that writes too many files is refused', async () => {
    const result = await execute('for index in range(30):\n    open(f"/output/f{index}.txt", "w").write("x")\n', { limits: { maxOutputFiles: 10 } })
    assert.equal(result.status, 'output_limit')
  })

  test('stdout beyond the stream cap is cut, not buffered', async () => {
    const result = await execute('import sys\nfor index in range(200000):\n    sys.stdout.write(f"line {index:08d} padding padding padding\\n")\n', { limits: { maxStreamBytes: 4096 } })
    assert.equal(result.status, 'ok', result.stderr.text)
    assert.equal(result.stdout.truncated, true)
    assert.ok(result.stdout.bytes > 5_000_000)
    assert.ok(result.stdout.text.length < 4096 + 64)
    assert.ok(result.stdout.text.startsWith('line 00000000'))
    assert.ok(result.stdout.text.trimEnd().endsWith('line 00199999 padding padding padding'))
  })

  test('the process count is capped', async () => {
    const result = await execute([
      'import threading, time',
      'started = 0',
      'try:',
      '    for _ in range(400):',
      '        threading.Thread(target=time.sleep, args=(5,), daemon=True).start()',
      '        started += 1',
      'except RuntimeError:',
      '    pass',
      'print(started)',
    ].join('\n'), { limits: { pidsLimit: 32 } })
    assert.equal(result.status, 'ok', result.stderr.text)
    assert.ok(Number(result.stdout.text) < 32, result.stdout.text)
  })

  test('runs beyond the concurrency limit wait, then are refused as busy', async () => {
    const shared = runner({ maxConcurrent: 1, queueWaitS: 1 })
    const dirs = async (label) => {
      const dir = join(root, label)
      const out = { codeDir: join(dir, 'code'), inputDir: join(dir, 'input'), outputDir: join(dir, 'output') }
      for (const path of Object.values(out)) await mkdir(path, { recursive: true })
      await chmod(out.outputDir, 0o777)
      await writeFile(join(out.codeDir, 'main.py'), 'import time\ntime.sleep(4)\n')
      return out
    }
    const first = shared.run({ name: `ae-test-${process.pid}-c1`, ...await dirs('c1') })
    const second = await shared.run({ name: `ae-test-${process.pid}-c2`, ...await dirs('c2') })
    assert.equal(second.status, 'busy')
    assert.equal((await first).status, 'ok')
  })

  test('cancelling a run kills its container', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1500)
    const result = await execute('import time\ntime.sleep(60)\n', { signal: controller.signal })
    assert.equal(result.status, 'cancelled')
    assert.equal(containerExists(result.name), false)
  })

  test('a missing image is a runtime error, not a pull', async () => {
    const missing = new ContainerRunner({ image: 'ours-analysis-exec:does-not-exist', limits: resolveLimits() })
    assert.equal((await missing.probe()).code, 'image_missing')
  })
})
