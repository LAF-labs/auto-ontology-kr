/**
 * Agent tools for reports and alert rules, as plain objects so they run
 * without the harness (`tools.js` wraps each with `defineTool`). Every tool
 * returns `{ok: true, …}` or `{ok: false, error: {code, message, details}}`.
 *
 * There is no tool that turns a rule on, deletes a rule or edits a report: a
 * proposed rule waits for a person in the Alerts panel, and reports are
 * append-only.
 */
import { InsightsError, renderPlain, reportSummary } from './reports.js'

export const TOOL_NAMES = Object.freeze(['report_save', 'report_list', 'report_read', 'alert_propose_rule', 'alert_list'])

/** Models often send an object or array argument as its JSON text; decode such a string, leave anything else. */
export function jsonArgument(value) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value
  try { return JSON.parse(value) } catch { return value } // not JSON: validation names the field
}

function failure(error) {
  if (error instanceof InsightsError) return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
  return { ok: false, error: { code: 'internal', message: String(error?.message ?? error), details: null } }
}

function figureBrief(figure) {
  if (figure.kind === 'change') return { id: figure.id, kind: 'change', text: figure.text, from: figure.from, to: figure.to }
  const brief = { id: figure.id, kind: figure.kind, analysis: `${figure.analysis.name ?? figure.analysis.id} v${figure.analysis.version}`, verified: figure.analysis.verified, params: figure.params, executed_at: figure.executed_at }
  return figure.kind === 'value' ? { ...brief, text: figure.text } : { ...brief, rows_shown: figure.table.shown, row_count: figure.table.row_count }
}

function ruleBrief(rule) {
  return {
    id: rule.id, name: rule.name, status: rule.status, created_by: rule.created_by, analysis_id: rule.analysis_id, analysis_name: rule.analysis_name,
    version: rule.version, params: rule.params, value: rule.value, condition: rule.condition, interval_s: rule.interval_s,
    last_value: rule.state.last_value, matched: rule.state.matched, last_evaluated_at: rule.state.last_evaluated_at, last_error: rule.state.last_error,
  }
}

const FIGURE_HELP = [
  'figures: [{id, kind, …}]. value: {id, kind: "value", analysis_id, version?, params?, column, row? | where?: {column: value}, reduce?: first|sum|min|max|count, format?: number|percent|raw, decimals?, label?}.',
  'table: {id, kind: "table", analysis_id, version?, params?, columns?: [names], max_rows? (≤ 50)}.',
  'change: {id, kind: "change", from: <value figure id>, to: <value figure id>, format?: change (percent, default)|difference}.',
  'percent format takes a ratio (0.25 → 25%).',
].join(' ')

/**
 * @param {object} deps
 * @param {import('./reports.js').ReportStore} deps.reports
 * @param {import('./alerts.js').AlertStore} deps.alerts
 * @param {(sessionId: string|undefined, scheduleId?: string) => Promise<object>} deps.triggerOf - what started the Session.
 * @param {(report: object) => void} [deps.onReport] - host event hook after a report is stored.
 * @returns {object[]} specs `{name, description, parameters, execute(args, {sessionId, signal})}`.
 */
export function insightsToolSpecs({ reports, alerts, triggerOf, onReport = () => {} }) {
  return [
    {
      name: 'report_save',
      description: [
        'Save a report that people read in the Reports panel. Write the text in Markdown and put every number in a figure: the host runs the saved analyses you name and inserts the values where the text says {{fig:<id>}}, with their source.',
        'Never type a number into title or body (dates, small counts up to 10 and parameter values are allowed); such text is refused with hand_written_numbers.',
        'A table figure placeholder belongs on its own line. Use verified analyses; a figure from an unverified version is saved but marked unverified.',
        'Run the analyses first (ao_run_analysis) to know their columns and rows; the host reads the same cached result.',
        'Write for a business owner: open with the conclusion in one or two sentences. Do not write column names, table names, ids, parameter names, SQL or a sources paragraph; the page lists every figure\'s source under the text. Name periods in words (지난달, 2026년 10월) and give each value figure a short label such as "2026년 10월".',
        'Reports cannot be edited after saving. When this session started from a scheduled reminder, do what it says and save the report; it is linked to that schedule.',
        'A recurring report is a scheduled task (schedule_create) with target new whose prompt names the saved analyses, their parameters (relative dates such as month_start(-1)) and what to compare, and asks to save the report with report_save.',
        FIGURE_HELP,
      ].join(' '),
      parameters: {
        title: { type: 'string', required: true, description: 'Report title, without numbers other than dates.' },
        body: { type: 'string', required: true, description: 'Markdown text with {{fig:<id>}} placeholders.' },
        figures: { type: 'array', required: true, items: { type: 'json' }, description: 'Figure definitions (see the tool description).' },
        schedule_id: { type: 'string', description: 'The schedule_id of the scheduled reminder this session received, if any.' },
      },
      async execute(args, { sessionId, signal }) {
        try {
          const figures = jsonArgument(args.figures)
          const input = { title: args.title, body: args.body, figures: Array.isArray(figures) ? figures.map(jsonArgument) : figures }
          const trigger = await triggerOf(sessionId, args.schedule_id)
          const report = await reports.save(input, { sessionId: sessionId ?? null, trigger, signal })
          onReport(report)
          return {
            ok: true, report_id: report.id, trigger: report.trigger,
            figures: Object.values(report.figures).map(figureBrief),
            unused_figures: report.unused_figures,
            rendered: renderPlain(report),
            note: 'Saved. People see it in the Reports panel with each value linked to its analysis run.',
          }
        } catch (error) { return failure(error) }
      },
    },
    {
      name: 'report_list',
      description: 'List saved reports, newest first: title, time, what started it (a schedule or a session) and the analyses it used.',
      parameters: {
        schedule_id: { type: 'string', description: 'Only reports saved by sessions this schedule started.' },
        limit: { type: 'integer', description: '1–50, default 20.' },
      },
      async execute(args) {
        const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 20
        const page = reports.list({ ...args.schedule_id === undefined ? {} : { schedule_id: args.schedule_id }, limit })
        return { ok: true, reports: page.data, total: page.total }
      },
    },
    {
      name: 'report_read',
      description: 'Read one saved report as text with its figure values and sources. Quote its numbers only as figures of a new report.',
      parameters: { id: { type: 'string', required: true } },
      async execute(args) {
        try {
          const report = reports.get(args.id)
          return { ok: true, report: { ...reportSummary(report), text: renderPlain(report), figures: Object.values(report.figures).map(figureBrief) } }
        } catch (error) { return failure(error) }
      },
    },
    {
      name: 'alert_propose_rule',
      description: [
        'Propose an alert rule on one verified saved analysis. The host evaluates rules on a timer without a model and lists firings in the Alerts panel.',
        'Your rule is saved as pending: it runs only after a person turns it on in the Alerts panel. Tell them so.',
        'value selects one number: {column, row? | where?: {column: value}, reduce?: first|sum|min|max|count}.',
        'condition: {kind: "threshold", op: > | >= | < | <=, value: number} or {kind: "change", op: >= | <= | abs>=, percent: number, previous_params: {…}} where previous_params are merged over params to read the previous period (for example start_date: month_start(-1), end_date: month_start(0) against params month_start(0), today).',
        'A rule fires when its condition becomes true and again only after it was false.',
      ].join(' '),
      parameters: {
        name: { type: 'string', required: true, description: 'What the alert watches, in the person\'s language.' },
        analysis_id: { type: 'string', required: true },
        version: { type: 'integer', description: 'Pin a verified version. Omit to follow the latest verified version.' },
        params: { type: 'object', additionalProperties: true, description: 'Analysis parameters (relative dates such as month_start(0) re-resolve at each evaluation).' },
        value: { type: 'object', additionalProperties: true, required: true, description: '{"column": "…", "row": 0}' },
        condition: { type: 'object', additionalProperties: true, required: true },
        interval_s: { type: 'integer', required: true, description: 'Seconds between evaluations.' },
      },
      async execute(args, { sessionId, signal }) {
        try {
          const input = Object.fromEntries(['name', 'analysis_id', 'version', 'params', 'value', 'condition', 'interval_s']
            .filter(key => args[key] !== undefined).map(key => [key, jsonArgument(args[key])]))
          const rule = await alerts.createRule(input, { createdBy: 'agent', sessionId: sessionId ?? null, signal })
          return { ok: true, rule: ruleBrief(rule), note: 'Saved as pending. A person must turn it on in the Alerts panel before it is evaluated.' }
        } catch (error) { return failure(error) }
      },
    },
    {
      name: 'alert_list',
      description: 'List alert rules (status pending, active or paused; last value and error) and the latest firings. When the person asks about an alert that went off, read it here first: each firing carries the saved analysis (id, name, version), the parameters and value selector the host used, the value and when it was read. Re-run that analysis with those parameters before explaining it, then compare periods or breakdowns with saved analyses; say which numbers come from a new question and are unreviewed.',
      parameters: { firings: { type: 'integer', description: 'Latest firings to include, 0–50, default 10.' } },
      async execute(args) {
        const limit = Number.isInteger(args.firings) ? Math.min(Math.max(args.firings, 0), 50) : 10
        const page = alerts.listFirings({ limit })
        return {
          ok: true, rules: alerts.listRules().map(ruleBrief), unread: page.unread,
          firings: page.data.map(f => ({
            id: f.id, rule_id: f.rule_id, rule_name: f.rule_name, fired_at: f.fired_at, value: f.value, value_text: f.value_text, condition: f.condition_text,
            previous_value: f.previous_value_text, change: f.change_text, analysis: f.analysis, params: f.params, previous_params: f.previous_params,
            value_selector: f.selector, column: f.column, executed_at: f.executed_at,
          })),
        }
      },
    },
  ]
}
