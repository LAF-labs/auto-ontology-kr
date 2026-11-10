/**
 * Agent tool definitions over the connector, as plain objects so they run
 * without the harness. `tools.js` wraps each with `defineTool`.
 *
 * Every tool returns `{ ok: true, ... }` or `{ ok: false, error }`: an
 * Auto-ontology refusal is a result the model acts on, not a tool failure.
 * Result rows beyond `maxRows` are cut and reported (`rows_shown`, `row_count`),
 * never summarized, so the model cannot mistake a partial table for the whole.
 */

export const TOOL_NAMES = Object.freeze([
  'ao_list_analyses', 'ao_get_analysis', 'ao_run_analysis',
  'ao_search_terms', 'ao_question_coverage', 'ao_ask_question',
])

function clipRows(data, maxRows) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.rows) || data.rows.length <= maxRows) return data
  return { ...data, rows: data.rows.slice(0, maxRows), rows_shown: maxRows }
}

function failure(result) {
  const { code, message, details, last_success: lastSuccess } = result.error
  return { ok: false, error: { code, message, details: details ?? null, ...lastSuccess ? { last_success: lastSuccess } : {} } }
}

/**
 * @param {object} connector - object with the AoConnector methods.
 * @param {{ maxRows: number }} options
 * @returns {object[]} tool specs `{ name, description, parameters, execute(args, signal) }`.
 */
export function aoToolSpecs(connector, { maxRows }) {
  return [
    {
      name: 'ao_list_analyses',
      description: 'List saved analyses: reviewed, versioned SQL that answers a business question with fixed parameters. Prefer running a verified saved analysis over asking a new question when one fits.',
      parameters: {
        query: { type: 'string', description: 'Substring of the name or description.' },
        status: { type: 'string', enum: ['verified', 'draft'], description: 'verified: has a verified version. draft: has none.' },
      },
      async execute(args, signal) {
        const result = await connector.listAnalyses({ query: args.query, status: args.status }, signal)
        return result.ok ? { ok: true, analyses: result.data, total: result.total ?? result.data.length } : failure(result)
      },
    },
    {
      name: 'ao_get_analysis',
      description: 'Read one saved analysis: its versions, SQL, parameter definitions (name, type, default, allowed values) and result columns. Read it before running to know which parameters exist.',
      parameters: {
        analysis_id: { type: 'string', required: true },
        version: { type: 'integer', description: 'Omit for the latest verified version, or the latest version when none is verified.' },
      },
      async execute(args, signal) {
        const result = await connector.getAnalysis(args.analysis_id, { version: args.version }, signal)
        return result.ok ? { ok: true, analysis: result.data } : failure(result)
      },
    },
    {
      name: 'ao_run_analysis',
      description: 'Run a saved analysis and return its rows. Omitting version runs the latest verified version. Parameters you omit take their defaults; dates accept YYYY-MM-DD or relative forms such as month_start(-1). The result states when it came from cache (cache.hit, executed_at). On failure, error.last_success holds the previous successful result for the same version and parameters, if any; say that it is older data when you use it.',
      parameters: {
        analysis_id: { type: 'string', required: true },
        version: { type: 'integer' },
        params: { type: 'object', additionalProperties: true, description: 'Parameter values by name.' },
        max_age_s: { type: 'integer', description: 'Oldest cached result to accept, in seconds. 0 always runs the query.' },
        row_limit: { type: 'integer', description: 'Rows to return; must not exceed the version row_limit.' },
      },
      async execute(args, signal) {
        const { analysis_id: analysisId, ...request } = args
        const result = await connector.runAnalysis(analysisId, request, signal)
        return result.ok ? { ok: true, result: clipRows(result.data, maxRows) } : failure(result)
      },
    },
    {
      name: 'ao_search_terms',
      description: 'Search the business glossary and data catalog by name (terms, their aliases, tables, columns). Use it to find the right business term or table before asking a question.',
      parameters: {
        search_term: { type: 'string', required: true, description: 'At least two characters.' },
      },
      async execute(args, signal) {
        const result = await connector.searchTerms(args.search_term, {}, signal)
        return result.ok ? { ok: true, hits: result.data, count: result.count } : failure(result)
      },
    },
    {
      name: 'ao_question_coverage',
      description: 'Grade from 0 to 1 how well the semantic layer covers the entities in a question, with the matched candidates. Low coverage means the data may not answer the question; check this before asking.',
      parameters: {
        question: { type: 'string', required: true },
      },
      async execute(args, signal) {
        const result = await connector.questionCoverage(args.question, {}, signal)
        return result.ok ? { ok: true, coverage: result.data } : failure(result)
      },
    },
    {
      name: 'ao_ask_question',
      description: 'Ask a new data question in natural language. Auto-ontology writes SQL, runs it, and returns the answer, the SQL and the rows. This takes tens of seconds and the SQL is not reviewed: state that the number comes from generated SQL and show the SQL.',
      parameters: {
        question: { type: 'string', required: true },
        target_db: { type: 'string', description: 'database_name to restrict the question to.' },
      },
      async execute(args, signal) {
        const result = await connector.askQuestion(args.question, { target_db: args.target_db }, signal)
        return result.ok ? { ok: true, answer: clipRows(result.data, maxRows) } : failure(result)
      },
    },
  ]
}
