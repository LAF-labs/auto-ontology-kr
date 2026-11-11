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
 *   host fills in the facts from its own record of the run (sources, forecast
 *   headline, numbers, tables, code); the model adds words only, and a forecast
 *   is refused without an interval that exists in the run's output.
 *
 * The descriptions also carry what a preset's persona would otherwise say
 * about these tools: when to use them, in which order, and that every output
 * file is read by a person who does not read code or column names.
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
      description: [
        'First of three steps for questions a confirmed analysis cannot answer by itself: a forecast of the next period, a comparison of groups (segments), a trend or seasonality breakdown, a correlation, or other statistics.',
        'Order: analysis_prepare_input for every input (call them all in one step, in parallel), then analysis_run_python, then analysis_present_result.',
        'This step fetches the whole result of a verified saved analysis as a file for the script: /input/<name>.csv (header = column names, empty cell = null; the result gives the exact path) and /input/<name>.columns.json (column types, units and display labels).',
        'Only verified versions are accepted, and only whole results; this is the only way to give data to a run. For a series over time, prepare one input per period when the analysis returns one number per period, and use at least six periods (twelve or more when asked about seasonality).',
        'Read the analysis with ao_get_analysis first to know its parameters. Preparing again under the same name replaces the file.',
      ].join(' '),
      parameters: {
        name: { type: 'string', required: true, description: 'File stem: a lowercase letter, then lowercase letters, digits or underscores (for example orders_2026_05).' },
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
      description: [
        `Run one complete Python script on prepared inputs in a new isolated environment and return its stdout, stderr and the files it wrote. Python 3.12 with pandas, numpy, scipy, statsmodels, scikit-learn and matplotlib; nothing can be installed and there is no network. /input is read-only and holds only the inputs you name; write results under /output (the working directory). Limits: ${limits.timeoutS} s, ${limits.memoryMb} MiB memory, ${Math.floor(limits.maxOutputBytes / 1048576)} MiB of output.`,
        'The person reads your output files directly on the result card and cannot read code or column names, so write for them, in their language:',
        '(1) CSV column headers are display names (for example 월, 예측, 예상 범위 하한, 예상 범위 상한; never names like lower_80). Use the labels and units from <name>.columns.json for existing measures.',
        '(2) /output/result.json is a flat JSON object whose keys are display names (for example "관측 개월 수": 6).',
        '(3) Round to what a person reads: counts as whole numbers, money without decimals, ratios as percent with one decimal (96.9, with % in the header or key).',
        '(4) Figures: one PNG is enough. Title, axis labels and legend in the language of the person (for example 실제, 예측, 예상 범위); the Korean font is already the default, so do not set fonts, styles, colors of text or background.',
        'For a forecast, write one CSV with one row per forecast period holding the point forecast and the lower and upper bounds of a prediction interval (80% unless asked otherwise), and plot the history, the forecast and the interval band. Prefer a simple method the data can support (few points: linear trend or mean; twelve or more: add seasonality) and print the fit quality you will need to describe how sure the result is.',
        'Print only what you need to read back. A failed run returns ok:false with the traceback in run.stderr; fix the script and run again.',
      ].join(' '),
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
      description: [
        'Show one successful run to the person as a result card below your reply. Call it once, for the run whose numbers you will report.',
        'The card takes its facts from the record of the run: which confirmed analyses were read, with which conditions and when; the headline of a forecast (read from the first row of the interval table and rounded for reading); the figures, tables and numbers the run wrote; and the code, folded away.',
        'You supply words only, in the language of the person, for a business owner who does not read statistics: title; summary (one plain sentence on how it was worked out, for example "지난 6개월의 추세를 직선으로 이어 11월을 가늠했습니다."); uncertainty (one or two plain sentences on how far to trust it and what could change it, without statistical terms); method and assumptions (the technical account, shown only under details).',
        'For kind forecast, interval is required.',
        'Afterwards reply briefly: the first sentence gives the answer with its number and range in plain words, rounded as a person would say it, and says it is an estimate, not a guarantee; then at most two or three sentences on why and how sure. Do not repeat the tables or the evidence (the card shows them), and never mention files, column names, code, Python, tools, versions or ids.',
      ].join(' '),
      parameters: {
        run_id: { type: 'string', required: true },
        title: { type: 'string', required: true, description: 'Short, in the words of the person, without method or period ranges in brackets (for example "11월 승인 리뷰 증빙 수 예측").' },
        kind: { type: 'string', enum: [...RESULT_KINDS], required: true, description: 'forecast: a future value with a range. segments: groups compared. trend: change over time broken down. other: any other statistic.' },
        summary: { type: 'string', required: true, description: 'One plain sentence: what was done to which numbers. No statistical terms.' },
        uncertainty: { type: 'string', required: true, description: 'One or two plain sentences: how far to trust the result and what could make it differ. No statistical terms.' },
        method: { type: 'string', required: true, description: 'Technical account for an expert: model or statistic, how the interval was built, fit quality.' },
        assumptions: { type: 'array', items: { type: 'string' }, required: true, description: 'Each assumption the result depends on, one per item.' },
        interval: {
          type: 'object',
          description: 'Required for kind forecast: where the forecast and its range are in the output.',
          additionalProperties: false,
          properties: {
            table: { type: 'string', description: 'CSV file of this run with one row per forecast period.' },
            point: { type: 'string', description: 'Column header of the point forecast.' },
            lower: { type: 'string', description: 'Column header of the lower bound.' },
            upper: { type: 'string', description: 'Column header of the upper bound.' },
            level: { type: 'number', description: 'Coverage the interval was built for, for example 0.8.' },
            label: { type: 'string', description: 'What the first row forecasts, in the words of the person, for example "11월 예측".' },
          },
        },
        unit: { type: 'string', description: 'Unit of the forecast, as the person writes it after a number (for example 건, 원, %).' },
        highlights: { type: 'array', items: { type: 'json' }, description: 'For kinds other than forecast: up to four keys of result.json to show large at the top, each a key or {"key": "…", "unit": "…"}.' },
        tables: { type: 'array', items: { type: 'json' }, description: 'CSV files to show, each a file name or {"file": "…", "title": "…"} with a title in the words of the person. Omit for all, up to four.' },
        figures: { type: 'array', items: { type: 'json' }, description: 'PNG or JPEG files to show, each a file name or {"file": "…", "title": "…"}. Omit for all, up to four.' },
      },
      execute(args, { sessionId }) {
        return runs.present(sessionId, args)
      },
    },
  ]
}
