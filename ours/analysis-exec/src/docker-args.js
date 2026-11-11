/**
 * The `docker run` argument list of one analysis run. Everything that isolates
 * a run is decided here and nowhere else:
 *
 * - a new container per run, removed when it exits (`--rm`), never pulled
 * - no network (`--network none`)
 * - non-root user, no capabilities, no privilege gain
 * - read-only root filesystem; /tmp is a small in-memory filesystem
 * - /code and /input are read-only bind mounts; /output is the only writable one
 * - CPU, memory (no extra swap), process count, file size and wall-clock caps
 *
 * The wall-clock cap is applied twice: `timeout` inside the container, and the
 * host's own timer in runner.js, which fires first.
 */

/** Seconds the in-container `timeout` waits beyond the host's timer. */
export const IN_CONTAINER_GRACE_S = 10

export const CONTAINER_LABEL = 'ours.analysis-exec'

const USER_PATTERN = /^[1-9]\d{0,9}:[1-9]\d{0,9}$/

function absolute(path, what) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes(',') || path.includes('\n')) {
    throw new TypeError(`${what} must be an absolute path without commas`)
  }
  return path
}

/**
 * @param {object} run
 * @param {string} run.image - image reference; never pulled at run time.
 * @param {string} run.name - container name, unique per run.
 * @param {string} run.codeDir - host directory holding main.py.
 * @param {string} run.inputDir - host directory holding this run's input files.
 * @param {string} run.outputDir - host directory the run may write.
 * @param {string} run.user - `uid:gid`, both non-zero.
 * @param {object} run.limits - resolved limits (src/limits.js).
 * @returns {string[]} arguments after the runtime binary.
 */
export function dockerRunArgs({ image, name, codeDir, inputDir, outputDir, user, limits }) {
  if (typeof image !== 'string' || image === '' || image.startsWith('-')) throw new TypeError('image must be an image reference')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name ?? '')) throw new TypeError('name must be a container name')
  if (!USER_PATTERN.test(user ?? '')) throw new TypeError('user must be uid:gid with a non-root uid and gid')
  return [
    'run', '--rm', '--pull', 'never',
    '--name', name,
    '--label', `${CONTAINER_LABEL}=1`,
    '--hostname', 'analysis',
    '--network', 'none',
    '--user', user,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--ipc', 'none',
    '--log-driver', 'none',
    '--no-healthcheck',
    '--cpus', String(limits.cpus),
    '--memory', `${limits.memoryMb}m`,
    '--memory-swap', `${limits.memoryMb}m`,
    '--pids-limit', String(limits.pidsLimit),
    '--ulimit', `fsize=${limits.maxFileBytes}:${limits.maxFileBytes}`,
    '--ulimit', 'core=0:0',
    '--ulimit', 'nofile=256:256',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpMb}m,mode=1777`,
    '--mount', `type=bind,source=${absolute(codeDir, 'codeDir')},target=/code,readonly`,
    '--mount', `type=bind,source=${absolute(inputDir, 'inputDir')},target=/input,readonly`,
    '--mount', `type=bind,source=${absolute(outputDir, 'outputDir')},target=/output`,
    '--workdir', '/output',
    '--entrypoint', 'timeout',
    image,
    '--signal', 'KILL', String(limits.timeoutS + IN_CONTAINER_GRACE_S),
    'python', '-B', '/opt/analysis/entry.py',
  ]
}
