/**
 * Agent tool definitions over AnalysisRuns, as plain objects so they run
 * without the harness. `tools.js` wraps each with `defineTool`.
 *
 * Three tools, split where the trust changes:
 *
 * - `analysis_prepare_input`: the host fetches data. Its arguments name a
 *   saved analysis and parameter values only, so the data a run sees is always
 *   a verified analysis result fetched by the host.
 * - `analysis_run_python`: the model's code runs, in the container. It can be
 *   called repeatedly while the model fixes its script; nothing it returns is
 *   shown as a finding.
 * - `analysis_present_result`: one finished run becomes a result card. The
 *   host fills in the evidence from its own record of the run; the model adds
 *   the method, the assumptions and the uncertainty, and a forecast is refused
 *   without an interval that exists in the run's output.
 *
 * Every tool returns `{ ok: true, ... }` or `{ ok: false, error }`.
 */
import { RESULT_KINDS } from './runs.js'

export const TOOL_NAMES = Object.freeze(['analysis_prepare_input', 'analysis_run_python', 'analysis_present_result'])

/**
 * @param {import('./runs.js').AnalysisRuns} runs
 * @returns {object[]} specs `{ name, description, parameters, execute(args, { sessionId, signal }) }`.
 */
export function analysisToolSpecs(runs) {
  const limits = runs.limits
  return [
    {
      name: 'analysis_prepare_input',
      description: 'Fetch the full result of a verified saved analysis as an input file for analysis_run_python. The host fetches the result and writes /input/<name>.csv (header = column names, empty cell = null; the result gives the path, which ends in .parquet when the deployment stores Parquet) and /input/<name>.columns.json (column types, units, labels). Only verified versions are accepted, and only whole results: when the result is refused as cut by a row limit, choose parameters or an analysis whose result fits. This is the only way to give data to a run; read the analysis with ao_get_analysis first to know its parameters. Preparing again under the same name replaces the file.',
      parameters: {
        name: { type: 'string', required: true, description: 'File stem: a lowercase letter, then lowercase letters, digits or underscores (for example monthly_sales).' },
        analysis_id: { type: 'string', required: true },
        version: { type: 'integer', description: 'Omit for the latest verified version.' },
        params: { type: 'object', additionalProperties: true, description: 'Parameter values by name; omitted ones take their defaults.' },
        max_age_s: { type: 'integer', description: 'Oldest cached result to accept, in seconds. 0 always reads the database.' },
      },
      execute(args, { sessionId, signal }) {
        return runs.prepareInput(sessionId, {
          name: args.name, analysisId: args.analysis_id, version: args.version, params: args.params, maxAgeS: args.max_age_s,
        }, signal)
      },
    },
    {
      name: 'analysis_run_python',
      description: `Run a Python script on prepared inputs in a new isolated container and return its stdout, stderr and the files it wrote. Python 3.12 with pandas, numpy, scipy, statsmodels, scikit-learn and matplotlib (Korean font installed); nothing can be installed. No network. /input is read-only and holds only the inputs you name; write every result under /output (the working directory). Limits: ${limits.timeoutS} s, ${limits.memoryMb} MiB memory, ${limits.cpus} CPU, ${Math.floor(limits.maxOutputBytes / 1048576)} MiB and ${limits.maxOutputFiles} files of output. Write tables as CSV, figures as PNG, and headline numbers as a flat JSON object in /output/result.json; print what you need to read back. For a forecast, write a CSV with the point forecast and lower and upper interval columns, and print how the interval was built. The container is discarded after the run, so each script must be complete. A failed run returns ok:false with the traceback in run.stderr.`,
      parameters: {
        code: { type: 'string', required: true, description: 'The whole Python script.' },
        inputs: { type: 'array', items: { type: 'string' }, required: true, description: 'Names of prepared inputs to mount under /input. At least one.' },
      },
      execute(args, { sessionId, signal }) {
        return runs.run(sessionId, { code: args.code, inputs: args.inputs }, signal)
      },
    },
    {
      name: 'analysis_present_result',
      description: 'Show one successful run to the person as a result card. The card carries the evidence, taken from the host record of the run: each input analysis with its version, parameters, read time and verified state, the code, the tables and figures the run wrote, and the numbers in result.json. You add the method, the assumptions and the uncertainty in the language of the person. For kind forecast, interval is required and must name a CSV of this run and its lower and upper columns. Present a run once, when its numbers are the ones you will report; only state numbers that appear in the run output.',
      parameters: {
        run_id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        kind: { type: 'string', enum: [...RESULT_KINDS], required: true },
        method: { type: 'string', required: true, description: 'What the script does to the inputs, in one to three sentences, naming the model or statistic.' },
        assumptions: { type: 'array', items: { type: 'string' }, required: true, description: 'Each assumption the result depends on, one per item.' },
        uncertainty: { type: 'string', required: true, description: 'How sure the result is and why: interval and its level, sample size, fit error, what could make it wrong.' },
        interval: {
          type: 'object',
          description: 'Required for kind forecast.',
          additionalProperties: false,
          properties: {
            table: { type: 'string', description: 'CSV artifact holding the interval.' },
            lower: { type: 'string', description: 'Column with the lower bound.' },
            upper: { type: 'string', description: 'Column with the upper bound.' },
            level: { type: 'number', description: 'Coverage the interval was built for, for example 0.8.' },
          },
        },
        tables: { type: 'array', items: { type: 'string' }, description: 'CSV artifacts to show. Omit for all, up to four.' },
        figures: { type: 'array', items: { type: 'string' }, description: 'PNG or JPEG artifacts to show. Omit for all, up to four.' },
      },
      execute(args, { sessionId }) {
        return runs.present(sessionId, args)
      },
    },
  ]
}
