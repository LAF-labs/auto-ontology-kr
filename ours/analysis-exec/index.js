/**
 * Host service `ctx.analysisExec`: prepares analysis inputs from verified
 * saved analyses and runs Python scripts on them in containers
 * (`src/runs.js`). The agent tools (`./tools`) and the artifact route
 * (`./http`) call it. A host without the container runtime or the image still
 * boots: each run then answers `runtime_unavailable` or `image_missing`.
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { InputStore, autoSource, exportApiSource, runApiSource } from './src/inputs.js'
import { DEFAULT_LIMITS, resolveLimits } from './src/limits.js'
import { ContainerRunner } from './src/runner.js'
import { AnalysisRuns } from './src/runs.js'

export default class AnalysisExec extends Service {
  static inject = ['aoConnector', 'credentials']

  static Config = z.object({
    dataDir: z.string().required().description('Directory for inputs, run directories and run records. The container runtime must be able to bind-mount paths under it.'),
    image: z.string().default('ours-analysis-exec:0.1').description('Image a run starts from; built from image/Dockerfile and never pulled at run time.'),
    runtime: z.string().default('docker').description('Container runtime binary (docker-compatible CLI).'),
    user: z.string().default('10001:10001').description('uid:gid inside the container; both non-zero. On a Linux host use an id that can read the data directory.'),
    inputSource: z.union(['run', 'export', 'auto']).default('run').description('Where prepared inputs come from: the saved-analysis run API (whole results within the version row limit only), the bulk export API, or auto (run API, and an export only for a result the run API cut).'),
    exportBaseUrl: z.string().default('http://127.0.0.1:3000').description('Gateway origin for the bulk export API.'),
    exportKeyEnv: z.string().default('AUTO_ONTOLOGY_EXPORT_TOKEN').description('Credential reference naming the token with analysis:export (role analysis_exporter). Only this host process uses it; a run never receives it.'),
    exportFormat: z.union(['csv', 'parquet']).default('csv').description('File format requested from the export API. parquet keeps column types.'),
    retentionDays: z.natural().min(1).default(30).description('Days a run directory (code, inputs, outputs, record) is kept. Older runs are deleted at start and every six hours.'),
    maxRows: z.natural().min(1).default(50).description('Rows of each output table returned to the model and shown on a card.'),
    cpus: z.number().min(0.1).default(DEFAULT_LIMITS.cpus).description('CPUs one run may use.'),
    memoryMb: z.natural().min(64).default(DEFAULT_LIMITS.memoryMb).description('Memory of one run in MiB.'),
    timeoutS: z.natural().min(1).default(DEFAULT_LIMITS.timeoutS).description('Wall-clock seconds before a run is killed.'),
    pidsLimit: z.natural().min(8).default(DEFAULT_LIMITS.pidsLimit).description('Processes and threads inside one run.'),
    tmpMb: z.natural().min(1).default(DEFAULT_LIMITS.tmpMb).description('Size of the in-memory /tmp in MiB.'),
    maxOutputBytes: z.natural().min(1).default(DEFAULT_LIMITS.maxOutputBytes).description('Total bytes one run may leave in its output directory.'),
    maxFileBytes: z.natural().min(1).default(DEFAULT_LIMITS.maxFileBytes).description('Largest single file a run may write.'),
    maxOutputFiles: z.natural().min(1).default(DEFAULT_LIMITS.maxOutputFiles).description('Files one run may leave in its output directory.'),
    maxStreamBytes: z.natural().min(1024).default(DEFAULT_LIMITS.maxStreamBytes).description('Bytes kept of stdout and of stderr.'),
    maxCodeBytes: z.natural().min(1).default(DEFAULT_LIMITS.maxCodeBytes).description('Largest script accepted.'),
    maxConcurrent: z.natural().min(1).default(DEFAULT_LIMITS.maxConcurrent).description('Runs in containers at once, across all sessions.'),
    queueWaitS: z.natural().min(1).default(DEFAULT_LIMITS.queueWaitS).description('Seconds a run waits for a free slot before it is refused as busy.'),
    maxInputsPerSession: z.natural().min(1).default(DEFAULT_LIMITS.maxInputsPerSession).description('Prepared inputs one session may hold.'),
  })

  constructor(ctx, config) {
    super(ctx, 'analysisExec')
    const { dataDir, image, runtime, user, inputSource, exportBaseUrl, exportKeyEnv, exportFormat, retentionDays, maxRows, ...limitValues } = config
    const limits = resolveLimits(limitValues)
    const connector = ctx.aoConnector
    const credentials = ctx.credentials
    const exported = () => exportApiSource({ baseUrl: exportBaseUrl, format: exportFormat, token: async () => (await credentials.resolve(exportKeyEnv))?.value })
    const source = inputSource === 'export' ? exported()
      : inputSource === 'auto' ? autoSource(runApiSource(connector), exported())
        : runApiSource(connector)
    this.runner = new ContainerRunner({ image, limits, runtime, user })
    this.runs = new AnalysisRuns({
      dataDir,
      runner: this.runner,
      inputs: new InputStore({ connector, source, maxInputs: limits.maxInputsPerSession }),
      limits,
      maxRows,
    })
    this.retentionMs = retentionDays * 86400000
  }

  async [Service.init]() {
    // Containers of a host process that died mid-run would otherwise stay until their own timeout.
    await this.runner.removeStale()
    const sweep = () => this.runs.sweep(this.retentionMs).catch(error => this.ctx.logger.warn(`analysis-exec: retention sweep failed: ${error?.message ?? String(error)}`))
    this.ctx.effect(() => {
      sweep()
      const timer = setInterval(sweep, 6 * 3600000)
      timer.unref()
      return () => clearInterval(timer)
    }, 'analysis-exec: retention sweep')
  }
}
