/**
 * Limits of one analysis run and of the runner as a whole. Every value is a
 * deployment setting (`analysis-exec` row config); these are the defaults and
 * the validation shared by the host service and the tests.
 */

export const DEFAULT_LIMITS = Object.freeze({
  /** CPUs one run may use (`docker run --cpus`). */
  cpus: 1,
  /** Memory of one run in MiB; swap is not added on top. */
  memoryMb: 1024,
  /** Wall-clock seconds before the host kills the container. */
  timeoutS: 120,
  /** Processes and threads inside the container. */
  pidsLimit: 128,
  /** Size of the in-memory /tmp in MiB (counted against memoryMb). */
  tmpMb: 64,
  /** Total bytes a run may leave in its output directory. */
  maxOutputBytes: 32 * 1024 * 1024,
  /** Largest single file a run may write (RLIMIT_FSIZE inside the container). */
  maxFileBytes: 16 * 1024 * 1024,
  /** Files a run may leave in its output directory. */
  maxOutputFiles: 64,
  /** Bytes kept of stdout and of stderr; the middle is cut. */
  maxStreamBytes: 64 * 1024,
  /** Largest script accepted, in bytes. */
  maxCodeBytes: 64 * 1024,
  /** Runs in containers at once, across all sessions. */
  maxConcurrent: 2,
  /** Seconds a run waits for a free slot before it is refused as busy. */
  queueWaitS: 30,
  /** Prepared inputs one session may hold. */
  maxInputsPerSession: 16,
})

const POSITIVE_INTEGERS = [
  'memoryMb', 'timeoutS', 'pidsLimit', 'tmpMb', 'maxOutputBytes', 'maxFileBytes', 'maxOutputFiles',
  'maxStreamBytes', 'maxCodeBytes', 'maxConcurrent', 'queueWaitS', 'maxInputsPerSession',
]

/**
 * @param {Partial<typeof DEFAULT_LIMITS>} [overrides]
 * @returns {typeof DEFAULT_LIMITS} complete limits.
 * @throws {TypeError} when a value is not a positive number of the expected kind.
 */
export function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    if (!(key in DEFAULT_LIMITS)) throw new TypeError(`unknown limit: ${key}`)
    limits[key] = value
  }
  if (typeof limits.cpus !== 'number' || !(limits.cpus > 0)) throw new TypeError('cpus must be a positive number')
  for (const key of POSITIVE_INTEGERS) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1) throw new TypeError(`${key} must be a positive integer`)
  }
  if (limits.maxFileBytes > limits.maxOutputBytes) limits.maxFileBytes = limits.maxOutputBytes
  return Object.freeze(limits)
}

/** @returns {object} the limits a result reports to the model and the card. */
export function publicLimits(limits) {
  return {
    cpus: limits.cpus,
    memory_mb: limits.memoryMb,
    timeout_s: limits.timeoutS,
    max_output_bytes: limits.maxOutputBytes,
    max_output_files: limits.maxOutputFiles,
  }
}
