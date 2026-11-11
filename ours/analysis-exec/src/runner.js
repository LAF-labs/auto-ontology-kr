/**
 * Runs one script in a fresh container and reports how it ended. The runner
 * owns the limits docker cannot express on a bind mount or a stream: the
 * wall-clock timer, the output directory size and file count, the stream
 * caps, and how many containers run at once.
 *
 * `run()` never rejects for a failing script: it resolves with a `status`.
 *
 *   ok             exit code 0 and the output directory is within its caps
 *   failed         the script exited non-zero (see stderr)
 *   timeout        killed after limits.timeoutS
 *   output_limit   killed, or refused afterwards, for exceeding the output caps
 *   killed         the container was killed from outside the runner; with exit
 *                  code 137 this is the kernel ending it at the memory limit
 *   cancelled      the caller's signal aborted the run
 *   busy           no slot became free within limits.queueWaitS
 *   runtime_error  the container runtime could not start the run
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dockerRunArgs, CONTAINER_LABEL } from './docker-args.js'

const WATCH_INTERVAL_MS = 500

/** Keeps the first and the last half of a stream within `cap` bytes. */
export class CappedStream {
  constructor(cap) {
    this.half = Math.max(1, Math.floor(cap / 2))
    this.head = []
    this.headBytes = 0
    this.tail = []
    this.tailBytes = 0
    this.total = 0
  }

  push(chunk) {
    this.total += chunk.length
    if (this.headBytes < this.half) {
      const take = chunk.subarray(0, this.half - this.headBytes)
      this.head.push(take)
      this.headBytes += take.length
      chunk = chunk.subarray(take.length)
    }
    if (chunk.length === 0) return
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tail.length > 1 && this.tailBytes - this.tail[0].length >= this.half) {
      this.tailBytes -= this.tail.shift().length
    }
  }

  /** @returns {{ text: string, bytes: number, truncated: boolean }} */
  result() {
    let tail = Buffer.concat(this.tail)
    if (tail.length > this.half) tail = tail.subarray(tail.length - this.half)
    const cut = this.total - this.headBytes - tail.length
    const head = Buffer.concat(this.head).toString('utf8')
    const text = cut > 0 ? `${head}\n… [${cut} bytes cut] …\n${tail.toString('utf8')}` : head + tail.toString('utf8')
    return { text, bytes: this.total, truncated: cut > 0 }
  }
}

/**
 * Size and file count of a directory tree, without following links.
 * @returns {Promise<{ bytes: number, files: number }>}
 */
export async function measureDirectory(dir) {
  let bytes = 0
  let files = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      files += 1
      if (entry.isDirectory()) { pending.push(path); continue }
      try {
        bytes += (await lstat(path)).size
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return { bytes, files }
}

export class ContainerRunner {
  /**
   * @param {object} options
   * @param {string} options.image
   * @param {object} options.limits - resolved limits (src/limits.js).
   * @param {string} [options.runtime] - container runtime binary.
   * @param {string} [options.user] - `uid:gid` the run uses.
   * @param {typeof nodeSpawn} [options.spawn]
   */
  constructor({ image, limits, runtime = 'docker', user = '10001:10001', spawn = nodeSpawn }) {
    this.image = image
    this.limits = limits
    this.runtime = runtime
    this.user = user
    this.spawn = spawn
    this.active = 0
    this.waiting = []
  }

  /** Runs the runtime with `args` and collects its output; never rejects. */
  exec(args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = this.spawn(this.runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: String(error?.message ?? error) })
        return
      }
      const out = new CappedStream(64 * 1024)
      const err = new CappedStream(64 * 1024)
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => err.push(chunk))
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: String(error?.message ?? error) }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out.result().text, stderr: err.result().text }) })
    })
  }

  /**
   * Whether the runtime answers and the image exists locally.
   * @returns {Promise<{ ok: true, imageId: string } | { ok: false, code: string, message: string }>}
   */
  async probe() {
    const result = await this.exec(['image', 'inspect', '--format', '{{.Id}}', this.image])
    if (result.code === 0) return { ok: true, imageId: result.stdout.trim() }
    if (result.code === null) return { ok: false, code: 'runtime_unavailable', message: `container runtime "${this.runtime}" could not be started: ${result.stderr.trim()}` }
    const detail = result.stderr.trim().split('\n').pop() ?? ''
    return /no such image/i.test(detail)
      ? { ok: false, code: 'image_missing', message: `image ${this.image} is not built on this host` }
      : { ok: false, code: 'runtime_unavailable', message: `container runtime is not answering: ${detail}` }
  }

  /** Removes containers a previous host process left behind. */
  async removeStale() {
    const listed = await this.exec(['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}=1`])
    const ids = listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : []
    if (ids.length > 0) await this.exec(['rm', '-f', ...ids])
    return ids.length
  }

  async acquire(signal) {
    if (this.active < this.limits.maxConcurrent) { this.active += 1; return 'acquired' }
    return new Promise((resolve) => {
      const entry = { grant: undefined }
      const finish = (outcome) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        resolve(outcome)
      }
      const onAbort = () => finish('cancelled')
      const timer = setTimeout(() => finish('busy'), this.limits.queueWaitS * 1000)
      entry.grant = () => finish('acquired')
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(entry)
    })
  }

  release() {
    const next = this.waiting.shift()
    if (next) next.grant()
    else this.active -= 1
  }

  /**
   * @param {object} request
   * @param {string} request.name - container name, unique per run.
   * @param {string} request.codeDir
   * @param {string} request.inputDir
   * @param {string} request.outputDir
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{ status: string, exitCode: number | null, durationMs: number, stdout: object, stderr: object, output: { bytes: number, files: number }, message: string | null }>}
   */
  async run({ name, codeDir, inputDir, outputDir, signal }) {
    const empty = { text: '', bytes: 0, truncated: false }
    const ended = (status, message) => ({ status, exitCode: null, durationMs: 0, stdout: empty, stderr: empty, output: { bytes: 0, files: 0 }, message })
    if (signal?.aborted) return ended('cancelled', 'cancelled before the run started')
    const slot = await this.acquire(signal)
    if (slot === 'busy') return ended('busy', `${this.limits.maxConcurrent} runs are already in progress; none finished within ${this.limits.queueWaitS} s`)
    if (slot === 'cancelled') return ended('cancelled', 'cancelled while waiting for a slot')
    try {
      return await this.runInSlot({ name, codeDir, inputDir, outputDir, signal })
    } finally {
      this.release()
    }
  }

  runInSlot({ name, codeDir, inputDir, outputDir, signal }) {
    const { limits } = this
    const args = dockerRunArgs({ image: this.image, name, codeDir, inputDir, outputDir, user: this.user, limits })
    const started = Date.now()
    return new Promise((resolve) => {
      let child
      try {
        child = this.spawn(this.runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ status: 'runtime_error', exitCode: null, durationMs: 0, stdout: { text: '', bytes: 0, truncated: false }, stderr: { text: '', bytes: 0, truncated: false }, output: { bytes: 0, files: 0 }, message: String(error?.message ?? error) })
        return
      }
      const stdout = new CappedStream(limits.maxStreamBytes)
      const stderr = new CappedStream(limits.maxStreamBytes)
      let reason = null
      let watching = false
      let settled = false

      const kill = (why) => {
        if (reason !== null) return
        reason = why
        // `docker kill` ends the container; killing only the client would leave it running.
        this.exec(['kill', name]).then((result) => {
          if (result.code !== 0 && !settled) child.kill('SIGKILL')
        })
      }
      const timer = setTimeout(() => kill('timeout'), limits.timeoutS * 1000)
      const watch = setInterval(async () => {
        if (watching || reason !== null) return
        watching = true
        try {
          const size = await measureDirectory(outputDir)
          if (size.bytes > limits.maxOutputBytes || size.files > limits.maxOutputFiles) kill('output_limit')
        } catch {
          // The directory is measured again after the run; a failed poll is not an outcome.
        } finally {
          watching = false
        }
      }, WATCH_INTERVAL_MS)
      const onAbort = () => kill('cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })

      const finish = async (exitCode, spawnError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(watch)
        signal?.removeEventListener('abort', onAbort)
        // `--rm` removes the container on exit; this covers a client that died first.
        if (reason !== null || spawnError) await this.exec(['rm', '-f', name])
        let output = { bytes: 0, files: 0 }
        try { output = await measureDirectory(outputDir) } catch { /* reported as empty output */ }
        const out = stdout.result()
        const err = stderr.result()
        let status
        let message = null
        if (spawnError) {
          status = 'runtime_error'
          message = `container runtime "${this.runtime}" could not be started: ${spawnError.message}`
        } else if (reason === 'timeout') {
          status = 'timeout'
          message = `killed after ${limits.timeoutS} s`
        } else if (reason === 'output_limit' || output.bytes > limits.maxOutputBytes || output.files > limits.maxOutputFiles) {
          status = 'output_limit'
          message = `output directory exceeded ${limits.maxOutputBytes} bytes or ${limits.maxOutputFiles} files`
        } else if (reason === 'cancelled') {
          status = 'cancelled'
          message = 'cancelled'
        } else if (exitCode === 0) {
          status = 'ok'
        } else if (exitCode === 125 || exitCode === 126 || exitCode === 127) {
          status = 'runtime_error'
          message = err.text.trim().split('\n').pop() || `container runtime exited with ${exitCode}`
        } else if (exitCode === 137) {
          status = 'killed'
          message = `the container was killed (exit 137); this is what exceeding the ${limits.memoryMb} MiB memory limit looks like`
        } else {
          status = 'failed'
          message = `the script exited with code ${exitCode}`
        }
        resolve({ status, exitCode: exitCode ?? null, durationMs: Date.now() - started, stdout: out, stderr: err, output, message })
      }

      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.on('error', error => finish(null, error))
      child.on('close', code => finish(code, null))
    })
  }
}
