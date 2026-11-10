/**
 * Dashboard edit session logic with no harness dependencies: draft operations,
 * the verified-analysis publish gate, static checks on generated widget
 * modules, and the editing tool definitions (plain objects; `editor-tools.js`
 * wraps them with `defineTool`).
 *
 * Every editing tool resolves the draft through the calling Session's binding
 * (`store.editorDraft(sessionId)`), so a Session that no edit button opened
 * gets `not_bound` whatever its preset. There is no publish tool: publishing
 * is a person's button.
 */
import { StoreError } from './store.js'
import { DEFAULTS, analysisIds, validateSpec } from './spec.js'

export const EDITOR_TOOL_NAMES = Object.freeze([
  'dashboard_read_draft', 'dashboard_edit_draft', 'dashboard_save_analysis', 'dashboard_save_widget_type',
])

const WIDGET_FIELDS = ['title', 'type', 'type_version', 'layout', 'source', 'refresh_s', 'options']
const DASHBOARD_FIELDS = ['title', 'description', 'grid', 'refresh_s', 'max_age_s']
const WIDGET_SOURCE_MAX = 256 * 1024

/**
 * Generated widget code never gets network, storage or cookie access: it runs
 * in a sandboxed frame with a `connect-src 'none'` policy. These patterns are a
 * second line that catches the attempt at save time with a reason the model
 * can act on; the frame is what enforces it.
 */
const FORBIDDEN_WIDGET_CODE = [
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/^\s*import\s/m, 'static import'],
  [/\bimportScripts\b/, 'importScripts'],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, 'browser storage'],
  [/\bdocument\.cookie\b/, 'document.cookie'],
  [/(?<![\w.$])(parent|top|opener)\s*\.|\bwindow\s*\.\s*(parent|top|opener)\b/, 'parent/top/opener'],
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\bWorker\s*\(/, 'Worker'],
  [/<\s*(script|iframe|img|link)\b/i, 'markup that loads resources'],
]

/**
 * Static problems of a generated widget module source.
 * @param {string} source
 * @returns {string[]} reasons; empty when the source passes.
 */
export function widgetSourceProblems(source) {
  if (typeof source !== 'string' || source.trim() === '') return ['source must be non-empty JavaScript']
  if (source.length > WIDGET_SOURCE_MAX) return [`source is longer than ${WIDGET_SOURCE_MAX} characters`]
  const problems = []
  const exportsMount = /\bexport\s+default\s*\{[\s\S]*\bmount\b/.test(source) || /\bexport\s+(async\s+)?function\s+mount\b|\bexport\s+(const|let)\s+mount\b/.test(source)
  if (!exportsMount) problems.push('the module must export mount: `export default { mount(el, props) { … return { update(props) {}, destroy() {} } } }`')
  for (const [pattern, label] of FORBIDDEN_WIDGET_CODE) if (pattern.test(source)) problems.push(`${label} is not allowed in a widget: widgets draw only from props`)
  return problems
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Set or delete (`null`) the listed fields of `target` from `changes`. Unknown fields are reported. */
function assignFields(target, changes, allowed, path, problems) {
  for (const [key, value] of Object.entries(changes)) {
    if (!allowed.includes(key)) { problems.push({ path: `${path}.${key}`, message: `unknown field; allowed: ${allowed.join(', ')}` }); continue }
    if (value === null) delete target[key]
    else target[key] = structuredClone(value)
  }
}

/**
 * Apply edit operations to a copy of `spec`. Operations run in order; the
 * result is validated as a whole by the caller.
 * @param {object} spec - current draft spec.
 * @param {Array<object>} operations - `{op: 'add_widget', widget}`, `{op: 'update_widget', id, changes}`,
 *   `{op: 'remove_widget', id}`, `{op: 'set_dashboard', changes}`.
 * @returns {{ spec: object, problems: Array<{ path: string, message: string }> }}
 */
export function applyOperations(spec, operations) {
  const next = structuredClone(spec)
  const problems = []
  if (!Array.isArray(operations) || operations.length === 0) return { spec: next, problems: [{ path: 'operations', message: 'give at least one operation' }] }
  operations.forEach((operation, index) => {
    const path = `operations[${index}]`
    if (!isObject(operation)) { problems.push({ path, message: 'must be an object' }); return }
    const at = id => next.widgets.findIndex(widget => widget.id === id)
    switch (operation.op) {
      case 'add_widget':
        if (!isObject(operation.widget)) problems.push({ path: `${path}.widget`, message: 'a widget object is required' })
        else next.widgets.push(structuredClone(operation.widget))
        break
      case 'update_widget': {
        const found = at(operation.id)
        if (found < 0) problems.push({ path: `${path}.id`, message: `no widget ${JSON.stringify(operation.id)}` })
        else if (!isObject(operation.changes)) problems.push({ path: `${path}.changes`, message: 'an object of fields to replace is required' })
        else assignFields(next.widgets[found], operation.changes, WIDGET_FIELDS, `${path}.changes`, problems)
        break
      }
      case 'remove_widget': {
        const found = at(operation.id)
        if (found < 0) problems.push({ path: `${path}.id`, message: `no widget ${JSON.stringify(operation.id)}` })
        else next.widgets.splice(found, 1)
        break
      }
      case 'set_dashboard':
        if (!isObject(operation.changes)) problems.push({ path: `${path}.changes`, message: 'an object of fields to replace is required' })
        else assignFields(next, operation.changes, DASHBOARD_FIELDS, `${path}.changes`, problems)
        break
      default:
        problems.push({ path: `${path}.op`, message: 'op must be add_widget, update_widget, remove_widget or set_dashboard' })
    }
  })
  return { spec: next, problems }
}

/** Unique `(analysis_id, version)` pairs a spec reads; `version` is null when the widget follows the latest verified version. */
export function analysisRefs(spec) {
  const seen = new Map()
  for (const widget of spec.widgets ?? []) {
    const id = widget.source?.analysis_id
    if (typeof id !== 'string') continue
    const version = Number.isInteger(widget.source.version) ? widget.source.version : null
    seen.set(`${id}\u0000${version}`, { analysis_id: id, version })
  }
  return [...seen.values()].sort((a, b) => a.analysis_id.localeCompare(b.analysis_id, 'und') || (a.version ?? 0) - (b.version ?? 0))
}

/**
 * The publish gate over Auto-ontology: which analysis versions a spec reads
 * that are not verified. A pinned version must itself be verified; an unpinned
 * widget needs the analysis to have a verified version. A lookup that fails
 * counts as unverified (`unchecked:<code>`), so an outage blocks publishing
 * instead of letting an unreviewed query through.
 * @param {{ getAnalysis: Function }} connector
 * @returns {(spec: object, signal?: AbortSignal) => Promise<Array<object>>}
 */
export function makeAnalysisGate(connector) {
  return async (spec, signal) => {
    const results = await Promise.all(analysisRefs(spec).map(async ({ analysis_id: id, version }) => {
      const found = await connector.getAnalysis(id, version === null ? {} : { version }, signal)
      if (!found.ok) return { analysis_id: id, version, reason: found.error.code === 'not_found' ? 'not_found' : `unchecked:${found.error.code}` }
      if (version !== null) {
        const status = found.data?.version?.status
        return status === 'verified' ? undefined : { analysis_id: id, version, reason: status ?? 'unknown', name: found.data?.name ?? null }
      }
      return found.data?.latest_verified_version == null
        ? { analysis_id: id, version: null, reason: 'no_verified_version', latest_version: found.data?.latest_version ?? null, name: found.data?.name ?? null }
        : undefined
    }))
    return results.filter(entry => entry !== undefined)
  }
}

function clipRows(rows, maxRows) {
  return Array.isArray(rows) && rows.length > maxRows ? { rows: rows.slice(0, maxRows), rows_shown: maxRows } : { rows }
}

function failure(code, message, details = null) {
  return { ok: false, error: { code, message, details } }
}

function fromStoreError(error) {
  if (error instanceof StoreError) return failure(error.code, error.message, error.details ?? null)
  throw error
}

function connectorFailure(result) {
  const { code, message, details } = result.error
  return failure(code, message, details ?? null)
}

/** Draft facts the model needs after every read or edit. */
function draftView(store, binding, draft) {
  return {
    dashboard_id: binding.dashboard_id,
    base_version: draft.base_version,
    updated_at: draft.updated_at,
    grid_columns: draft.spec.grid?.columns ?? DEFAULTS.gridColumns,
    spec: draft.spec,
    analysis_ids: analysisIds(draft.spec),
  }
}

/**
 * Editing tool definitions.
 * @param {object} deps
 * @param {import('./store.js').DashboardStore} deps.store
 * @param {object} deps.connector - AoConnector methods (getAnalysis, createAnalysis, addVersion).
 * @param {(spec: object, signal?: AbortSignal) => Promise<object[]>} deps.gate - from makeAnalysisGate.
 * @param {number} deps.maxRows - preview rows returned to the model.
 * @returns {object[]} specs `{ name, description, parameters, execute(args, { sessionId, signal }) }`.
 */
/**
 * Models often send an object or array argument as its JSON text. Decode such a
 * string; any other value, or text that is not JSON, is returned unchanged so the
 * connector's field check reports it.
 * @param {unknown} value - One tool argument.
 * @returns {unknown}
 */
function jsonArgument(value) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value
  try { return JSON.parse(value) } catch { return value } // not JSON: the connector names the field
}

export function editorToolSpecs({ store, connector, gate, maxRows }) {
  const widgetTypes = () => store.listWidgets().map(({ type, version, origin, description }) => ({ type, version, origin, description }))
  const unverified = async (spec, signal) => {
    const list = await gate(spec, signal)
    return list.length === 0 ? [] : list
  }

  return [
    {
      name: 'dashboard_read_draft',
      description: 'Read the dashboard draft this session edits: its spec (grid, widgets with layout, source analysis and options), the widget types available, and which analyses are not yet verified. Read it before every edit; a person may have changed the draft in between.',
      parameters: {},
      async execute(_args, { sessionId, signal }) {
        let resolved
        try { resolved = store.editorDraft(sessionId) } catch (error) { return fromStoreError(error) }
        const { binding, draft } = resolved
        return {
          ok: true,
          draft: draftView(store, binding, draft),
          widget_types: widgetTypes(),
          unverified_analyses: await unverified(draft.spec, signal),
        }
      },
    },
    {
      name: 'dashboard_edit_draft',
      description: [
        'Change the dashboard draft with a list of operations, applied in order and saved only if the whole result is valid (otherwise nothing changes and the problems are listed).',
        'Operations: {"op":"add_widget","widget":{id,type,type_version,title,layout:{x,y,w,h},source:{analysis_id,version?,params?},options?}};',
        '{"op":"update_widget","id":"…","changes":{field: value}} replaces whole fields (title, type, type_version, layout, source, refresh_s, options; null removes an optional field);',
        '{"op":"remove_widget","id":"…"}; {"op":"set_dashboard","changes":{title?, description?, grid?, refresh_s?, max_age_s?}}.',
        'Layouts are grid cells (x + w ≤ grid columns) and must not overlap. A widget shows one saved analysis by id; never put SQL in the dashboard.',
        'To show a draft analysis you saved, set source.version to that version; the draft previews it, and publishing waits until a person verifies it.',
      ].join(' '),
      parameters: {
        operations: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', enum: ['add_widget', 'update_widget', 'remove_widget', 'set_dashboard'], required: true },
              id: { type: 'string', description: 'Widget id (update_widget, remove_widget).' },
              widget: { type: 'json', description: 'Complete widget object (add_widget).' },
              changes: { type: 'json', description: 'Fields to replace (update_widget, set_dashboard).' },
            },
          },
        },
      },
      async execute(args, { sessionId, signal }) {
        let resolved
        try { resolved = store.editorDraft(sessionId) } catch (error) { return fromStoreError(error) }
        const { binding, draft } = resolved
        const { spec, problems } = applyOperations(draft.spec, args.operations)
        if (problems.length > 0) return failure('invalid_operations', 'nothing was changed', { problems })
        const checked = validateSpec(spec, { hasWidget: store.hasWidget })
        if (!checked.ok) return failure('invalid_spec', 'the result is not a valid dashboard; nothing was changed', { problems: checked.problems })
        let saved
        try { saved = await store.saveDraft(binding.dashboard_id, binding.owner, spec) } catch (error) { return fromStoreError(error) }
        return {
          ok: true,
          draft: { dashboard_id: saved.id, base_version: saved.base_version, updated_at: saved.updated_at, widgets: saved.spec.widgets.map(w => ({ id: w.id, type: `${w.type}@${w.type_version}`, layout: w.layout, analysis_id: w.source.analysis_id, ...w.source.version === undefined ? {} : { version: w.source.version } })) },
          unverified_analyses: await unverified(spec, signal),
          note: 'The person sees the change in the preview beside this conversation. Only they can publish.',
        }
      },
    },
    {
      name: 'dashboard_save_analysis',
      description: [
        'Save a new saved analysis as a draft (or, with analysis_id, a new draft version of an existing one) when no existing analysis answers what a widget needs. Check ao_list_analyses first.',
        'Auto-ontology checks that the SQL is a single read-only SELECT, runs it once and fixes the result columns; the result shows those columns and a few preview rows.',
        'Use :name placeholders with params definitions ([{name, type: date|datetime|int|number|string|bool|enum|list<…>, required?, default?, values?, min?, max?}]) for values a viewer may change, and column_hints ({column: {role: dimension|measure|time, unit?, label?}}) so widgets get labels and units.',
        'The saved version is a draft: a person verifies it in the edit panel before the dashboard can be published. You cannot verify it.',
      ].join(' '),
      parameters: {
        analysis_id: { type: 'string', description: 'Existing analysis to add a version to. Omit to create a new analysis.' },
        name: { type: 'string', description: 'Unique name of a new analysis, phrased as the business question it answers.' },
        description: { type: 'string' },
        database_name: { type: 'string', description: 'Database to run on, as the database_name of an existing analysis. Required for a new analysis.' },
        sql: { type: 'string', required: true, description: 'One SELECT statement, with :name placeholders for parameters.' },
        params: { type: 'array', items: { type: 'json' }, description: 'Parameter definitions.' },
        column_hints: { type: 'object', additionalProperties: true, description: 'Object keyed by column name: {"share_pct": {"role": "measure", "unit": "%", "label": "Share"}}. Pass an object, not a JSON string.' },
        sample_params: { type: 'object', additionalProperties: true, description: 'Values for required parameters without a default, used for the save-time run.' },
      },
      async execute(args, { sessionId, signal }) {
        try { store.editorDraft(sessionId) } catch (error) { return fromStoreError(error) }
        const fields = Object.fromEntries(['description', 'sql', 'params', 'column_hints', 'sample_params'].filter(key => args[key] !== undefined).map(key => [key, key === 'description' || key === 'sql' ? args[key] : jsonArgument(args[key])]))
        const result = args.analysis_id === undefined
          ? await connector.createAnalysis({ name: args.name, database_name: args.database_name, ...fields }, signal)
          : await connector.addVersion(args.analysis_id, fields, signal)
        if (!result.ok) return connectorFailure(result)
        const data = result.data
        const version = data.version?.version
        await store.noteEditorAnalysis(sessionId, { analysis_id: data.id, version, name: data.name, saved_at: new Date().toISOString() })
        const preview = data.preview ?? {}
        return {
          ok: true,
          analysis_id: data.id,
          name: data.name,
          version,
          status: data.version?.status ?? 'draft',
          columns: preview.columns ?? data.version?.columns ?? [],
          ...clipRows(preview.rows ?? [], maxRows),
          row_count: preview.row_count ?? null,
          next: `Bind widgets with source {"analysis_id": ${JSON.stringify(data.id)}, "version": ${version}} to preview it. A person must verify version ${version} before the dashboard can be published.`,
        }
      },
    },
    {
      name: 'dashboard_save_widget_type',
      description: [
        'Save a new widget type (an ES module) when no existing type can show what is needed. Load the dashboard-widget-authoring skill first and follow it.',
        'The module is stored as the next version of `type` and is immutable; to change it, save again (a new version) and point widgets at that type_version.',
        'Generated widgets run in a sandboxed frame without network or storage; code that tries is refused here.',
      ].join(' '),
      parameters: {
        type: { type: 'string', required: true, description: 'Lowercase type name, e.g. "gauge".' },
        description: { type: 'string', required: true, description: 'What the widget shows, one line.' },
        source: { type: 'string', required: true, description: 'Complete ES module source.' },
      },
      async execute(args, { sessionId }) {
        try { store.editorDraft(sessionId) } catch (error) { return fromStoreError(error) }
        const problems = widgetSourceProblems(args.source)
        if (problems.length > 0) return failure('invalid_widget', 'the module was not saved', { problems })
        const version = store.nextWidgetVersion(args.type)
        try {
          const saved = await store.putWidget({ type: args.type, version, source: args.source, description: args.description, origin: 'generated' })
          return { ok: true, type: saved.type, type_version: saved.version, next: `Use "type": ${JSON.stringify(saved.type)}, "type_version": ${saved.version} in a widget. Check the preview with the person.` }
        } catch (error) { return fromStoreError(error) }
      },
    },
  ]
}
