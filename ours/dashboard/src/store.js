/**
 * Dashboard store over a storage domain (see DOMAIN). Versions are immutable;
 * a dashboard's `published_version` is the pointer every browser reads. A draft
 * belongs to one owner (an opaque browser id) and is invisible to others.
 * Publish and revert check the pointer against the caller's base inside a
 * per-dashboard lock, so of two concurrent publishers from the same base the
 * second gets `base_changed` unless it forces.
 *
 * Draft ownership is visibility, not authorization: every caller is the same
 * authenticated harness owner.
 *
 * An editor session (`editors`, keyed by Session id) is bound to one owner's
 * draft of one dashboard; the editing tools act only on that draft. Publishing
 * runs the `checkAnalyses` gate: a draft that reads an unverified analysis
 * cannot be published, forced or not.
 */
import { createHash } from 'node:crypto'
import { DASHBOARD_ID_RE, WIDGET_TYPE_RE, analysisIds, validateSpec, widgetRefs } from './spec.js'

export const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/
/** `basic`: seeded by a host package and trusted to run in the page. `generated`: anything else, run in a sandboxed frame. */
export const WIDGET_ORIGINS = Object.freeze(['basic', 'generated'])
const HISTORY_MAX = 100
const EDITOR_ANALYSES_MAX = 50

const passThrough = { parse: value => value }

/** Storage-domain spec (plain object; `ctx.storageDomain.open` accepts it as `defineDomain` would return it). */
export const DOMAIN = Object.freeze({
  name: 'ours_dashboard',
  version: 2,
  // v2 added the `editors` table and widget `origin`; v1 data reads unchanged (a missing origin is `generated`).
  compatibleVersions: [1],
  global: { schema: { parse: value => value, safeParse: value => ({ success: value !== null && typeof value === 'object' }) }, initial: { home: null } },
  tables: {
    dashboards: { valueSchema: passThrough },
    versions: { valueSchema: passThrough },
    drafts: { valueSchema: passThrough },
    widgets: { valueSchema: passThrough },
    editors: { valueSchema: passThrough },
  },
})

export class StoreError extends Error {
  /**
   * @param {number} status - HTTP status for the browser route.
   * @param {string} code - stable error code.
   * @param {string} message
   * @param {object|null} [details]
   */
  constructor(status, code, message, details = null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

const versionKey = (id, version) => `${id}:${version}`
const draftKey = (id, owner) => `${id}:${owner}`
const widgetKey = (type, version) => `${type}:${version}`
const sha256 = text => createHash('sha256').update(text).digest('hex')

export class DashboardStore {
  /**
   * @param {object} domain - opened storage domain (`global`, `table(name)`).
   * @param {object} [options]
   * @param {() => Date} [options.now]
   * @param {(spec: object, signal?: AbortSignal) => Promise<Array<{ analysis_id: string, version: number|null, reason: string }>>} [options.checkAnalyses]
   *   publish gate: the analyses of `spec` that are not verified (empty when all are). Without it, publish checks nothing.
   */
  constructor(domain, { now = () => new Date(), checkAnalyses } = {}) {
    this.domain = domain
    this.now = now
    this.checkAnalyses = checkAnalyses
    this.locks = new Map()
  }

  get dashboards() { return this.domain.table('dashboards') }
  get versions() { return this.domain.table('versions') }
  get drafts() { return this.domain.table('drafts') }
  get widgets() { return this.domain.table('widgets') }
  get editors() { return this.domain.table('editors') }

  async locked(id, fn) {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const chained = previous.then(() => current)
    this.locks.set(id, chained)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(id) === chained) this.locks.delete(id)
    }
  }

  hasWidget = (type, version) => this.widgets.get(widgetKey(type, version)) !== undefined

  checkSpec(spec) {
    const result = validateSpec(spec, { hasWidget: this.hasWidget })
    if (!result.ok) throw new StoreError(422, 'invalid_spec', 'the spec is not valid', { problems: result.problems })
    return spec
  }

  /** Dashboards visible to `owner`: published ones plus that owner's never-published drafts. */
  list(owner) {
    const rows = []
    for (const [, record] of this.dashboards.entries()) {
      const draft = owner === undefined ? undefined : this.drafts.get(draftKey(record.id, owner))
      if (record.published_version === null && draft === undefined) continue
      const published = record.published_version === null ? undefined : this.versions.get(versionKey(record.id, record.published_version))
      const spec = published?.spec ?? draft?.spec
      rows.push({
        id: record.id,
        title: spec?.title ?? record.id,
        published_version: record.published_version,
        published_at: record.published_at,
        latest_version: record.latest_version,
        analysis_ids: spec === undefined ? [] : analysisIds(spec),
        has_draft: draft !== undefined,
      })
    }
    rows.sort((a, b) => a.title.localeCompare(b.title, 'und') || a.id.localeCompare(b.id, 'und'))
    const home = this.domain.global.get().home
    return { data: rows, home: rows.some(row => row.id === home && row.published_version !== null) ? home : null }
  }

  record(id) {
    if (typeof id !== 'string' || !DASHBOARD_ID_RE.test(id)) throw new StoreError(400, 'invalid_request', `dashboard id must match ${DASHBOARD_ID_RE}`)
    return this.dashboards.get(id)
  }

  /** The published spec, or the owner's draft (`view: 'draft'`). */
  get(id, { view = 'published', owner } = {}) {
    const record = this.record(id)
    if (view === 'draft') {
      const draft = owner === undefined ? undefined : this.drafts.get(draftKey(id, owner))
      if (draft === undefined) throw new StoreError(404, 'not_found', `no draft of ${id} for this browser`)
      return { id, view, version: null, base_version: draft.base_version, published_version: record?.published_version ?? null, updated_at: draft.updated_at, spec: draft.spec, analysis_ids: analysisIds(draft.spec), widget_refs: widgetRefs(draft.spec) }
    }
    if (view !== 'published') throw new StoreError(400, 'invalid_request', 'view must be published or draft')
    if (record === undefined || record.published_version === null) throw new StoreError(404, 'not_found', `dashboard ${id} is not published`)
    const version = this.versions.get(versionKey(id, record.published_version))
    return { id, view, version: version.version, published_version: record.published_version, published_at: record.published_at, spec: version.spec, analysis_ids: analysisIds(version.spec), widget_refs: widgetRefs(version.spec) }
  }

  versionsOf(id) {
    const record = this.record(id)
    if (record === undefined) throw new StoreError(404, 'not_found', `no dashboard ${id}`)
    const list = []
    for (let version = 1; version <= record.latest_version; version += 1) {
      const entry = this.versions.get(versionKey(id, version))
      if (entry !== undefined) list.push({ version, created_at: entry.created_at, base_version: entry.base_version, title: entry.spec.title, widgets: entry.spec.widgets.length })
    }
    return { id, published_version: record.published_version, versions: list.reverse(), history: record.history }
  }

  /**
   * Create or replace the owner's draft. Without `spec`, copies the published version.
   * A new dashboard id with a spec creates an unpublished dashboard (base 0).
   */
  async saveDraft(id, owner, spec) {
    this.checkOwner(owner)
    return this.locked(id, async () => {
      const record = this.record(id)
      const existing = this.drafts.get(draftKey(id, owner))
      let base = existing?.base_version ?? record?.published_version ?? 0
      let next = spec
      if (next === undefined) {
        if (existing !== undefined) return this.get(id, { view: 'draft', owner })
        if (record === undefined || record.published_version === null) throw new StoreError(404, 'not_found', `dashboard ${id} has no published version to copy`)
        next = this.versions.get(versionKey(id, record.published_version)).spec
        base = record.published_version
      }
      this.checkSpec(next)
      if (record === undefined) {
        await this.dashboards.put(id, { id, created_at: this.now().toISOString(), published_version: null, published_at: null, latest_version: 0, history: [] })
      }
      await this.drafts.put(draftKey(id, owner), { id, owner, base_version: base, spec: next, updated_at: this.now().toISOString() })
      return this.get(id, { view: 'draft', owner })
    })
  }

  async discardDraft(id, owner) {
    this.checkOwner(owner)
    return this.locked(id, async () => {
      this.record(id)
      const deleted = await this.drafts.delete(draftKey(id, owner))
      if (!deleted) throw new StoreError(404, 'not_found', `no draft of ${id} for this browser`)
      return { id, discarded: true }
    })
  }

  /** Publish the owner's draft as a new immutable version. */
  async publish(id, owner, { force = false } = {}) {
    this.checkOwner(owner)
    return this.locked(id, async () => {
      const record = this.record(id)
      const draft = this.drafts.get(draftKey(id, owner))
      if (record === undefined || draft === undefined) throw new StoreError(404, 'not_found', `no draft of ${id} for this browser`)
      this.checkSpec(draft.spec)
      if (this.checkAnalyses !== undefined) {
        const unverified = await this.checkAnalyses(draft.spec)
        if (unverified.length > 0) {
          throw new StoreError(409, 'unverified_analyses', `the draft reads ${unverified.length} analysis version(s) nobody has verified yet`, { analyses: unverified })
        }
      }
      const current = record.published_version ?? 0
      if (current !== draft.base_version && !force) {
        throw new StoreError(409, 'base_changed', `dashboard ${id} was published as v${current} after this draft started from v${draft.base_version}`, {
          base_version: draft.base_version, published_version: current, published_at: record.published_at,
        })
      }
      const at = this.now().toISOString()
      const version = record.latest_version + 1
      await this.versions.put(versionKey(id, version), { id, version, spec: draft.spec, created_at: at, base_version: draft.base_version })
      await this.dashboards.put(id, {
        ...record, published_version: version, published_at: at, latest_version: version,
        history: [...record.history, { action: 'publish', version, from: current, at, forced: current !== draft.base_version }].slice(-HISTORY_MAX),
      })
      await this.drafts.delete(draftKey(id, owner))
      return { id, version, published_at: at, replaced: current }
    })
  }

  /** Point the dashboard back at an earlier version. `expected` guards against a concurrent change. */
  async revert(id, version, { expected } = {}) {
    return this.locked(id, async () => {
      const record = this.record(id)
      if (record === undefined) throw new StoreError(404, 'not_found', `no dashboard ${id}`)
      if (!Number.isInteger(version) || this.versions.get(versionKey(id, version)) === undefined) throw new StoreError(404, 'not_found', `dashboard ${id} has no version ${version}`)
      const current = record.published_version ?? 0
      if (expected !== undefined && expected !== current) {
        throw new StoreError(409, 'base_changed', `dashboard ${id} is now at v${current}, not v${expected}`, { expected, published_version: current, published_at: record.published_at })
      }
      const at = this.now().toISOString()
      await this.dashboards.put(id, {
        ...record, published_version: version, published_at: at,
        history: [...record.history, { action: 'revert', version, from: current, at }].slice(-HISTORY_MAX),
      })
      return { id, version, published_at: at, replaced: current }
    })
  }

  async setHome(id) {
    const record = this.record(id)
    if (record === undefined || record.published_version === null) throw new StoreError(404, 'not_found', `dashboard ${id} is not published`)
    await this.domain.global.set({ ...this.domain.global.get(), home: id })
    return { home: id }
  }

  /**
   * Add one immutable widget module version. Same content again is a no-op
   * (except that a host seed may mark it `basic`); different content is refused.
   */
  async putWidget({ type, version, source, description, origin = 'generated' }) {
    if (!WIDGET_ORIGINS.includes(origin)) throw new StoreError(400, 'invalid_request', `widget origin must be one of ${WIDGET_ORIGINS.join(', ')}`)
    if (typeof type !== 'string' || !WIDGET_TYPE_RE.test(type)) throw new StoreError(400, 'invalid_request', `widget type must match ${WIDGET_TYPE_RE}`)
    if (!Number.isInteger(version) || version < 1) throw new StoreError(400, 'invalid_request', 'widget version must be a positive integer')
    if (typeof source !== 'string' || source.length === 0 || source.length > 512 * 1024) throw new StoreError(400, 'invalid_request', 'widget source must be 1 byte..512 KiB of JavaScript')
    const key = widgetKey(type, version)
    const digest = sha256(source)
    const existing = this.widgets.get(key)
    if (existing !== undefined) {
      if (existing.sha256 === digest) {
        if (origin === 'basic' && existing.origin !== 'basic') await this.widgets.put(key, { ...existing, origin })
        return { type, version, sha256: digest, created: false, origin: origin === 'basic' ? 'basic' : existing.origin ?? 'generated' }
      }
      throw new StoreError(409, 'widget_exists', `${type}@${version} already exists with different content; publish a new version`, { sha256: existing.sha256 })
    }
    await this.widgets.put(key, { type, version, source, sha256: digest, origin, description: typeof description === 'string' ? description : null, created_at: this.now().toISOString() })
    return { type, version, sha256: digest, created: true, origin }
  }

  /** Next free version number of a widget type (1 for a new type). */
  nextWidgetVersion(type) {
    let max = 0
    for (const [, entry] of this.widgets.entries()) if (entry.type === type) max = Math.max(max, entry.version)
    return max + 1
  }

  widget(type, version) {
    return this.widgets.get(widgetKey(type, version))
  }

  listWidgets() {
    const out = []
    for (const [, entry] of this.widgets.entries()) out.push({ type: entry.type, version: entry.version, sha256: entry.sha256, origin: entry.origin ?? 'generated', description: entry.description, created_at: entry.created_at })
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version)
  }

  /** Whether `owner` has a draft of `id`. */
  hasDraft(id, owner) {
    this.checkOwner(owner)
    return this.drafts.get(draftKey(id, owner)) !== undefined
  }

  /** Bind an editor Session to the owner's existing draft of `id`. */
  async bindEditor(sessionId, id, owner) {
    this.checkOwner(owner)
    if (typeof sessionId !== 'string' || sessionId === '') throw new StoreError(400, 'invalid_request', 'session id required')
    if (this.drafts.get(draftKey(id, owner)) === undefined) throw new StoreError(404, 'not_found', `no draft of ${id} for this browser`)
    const record = { session_id: sessionId, dashboard_id: id, owner, created_at: this.now().toISOString(), analyses: [] }
    await this.editors.put(sessionId, record)
    return record
  }

  /** The binding of an editor Session, or undefined for any other Session. */
  editor(sessionId) {
    return typeof sessionId === 'string' ? this.editors.get(sessionId) : undefined
  }

  /** Editor Sessions bound to `owner`'s draft of `id`, newest first. */
  editorsOf(id, owner) {
    const out = []
    for (const [, record] of this.editors.entries()) if (record.dashboard_id === id && record.owner === owner) out.push(record)
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  /** Remember an analysis version an editor Session saved, so the edit panel can offer its verification. */
  async noteEditorAnalysis(sessionId, entry) {
    const record = this.editor(sessionId)
    if (record === undefined) return undefined
    const analyses = [...record.analyses.filter(a => !(a.analysis_id === entry.analysis_id && a.version === entry.version)), entry].slice(-EDITOR_ANALYSES_MAX)
    const next = { ...record, analyses }
    await this.editors.put(sessionId, next)
    return next
  }

  /**
   * The draft an editor Session edits: `{ binding, draft }`, or a StoreError
   * the editing tools report (`not_bound`, or `draft_gone` after a publish or discard).
   */
  editorDraft(sessionId) {
    const binding = this.editor(sessionId)
    if (binding === undefined) throw new StoreError(403, 'not_bound', 'this session is not a dashboard edit session; open one with the dashboard edit button')
    const draft = this.drafts.get(draftKey(binding.dashboard_id, binding.owner))
    if (draft === undefined) throw new StoreError(409, 'draft_gone', `the draft of ${binding.dashboard_id} was published or discarded; open a new edit session from the dashboard`)
    return { binding, draft }
  }

  checkOwner(owner) {
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) throw new StoreError(400, 'invalid_request', 'a draft owner id (x-ours-draft-owner) is required')
  }
}

/** In-memory domain with the storage-domain surface, for tests. */
export function memoryDomain() {
  let global = { home: null }
  const tables = new Map()
  const table = name => {
    if (!tables.has(name)) {
      const map = new Map()
      tables.set(name, {
        get: key => map.get(key),
        entries: () => map.entries(),
        keys: () => map.keys(),
        get size() { return map.size },
        put: async (key, value) => { map.set(key, structuredClone(value)) },
        delete: async key => map.delete(key),
        update: async (key, fn) => { const next = fn(map.get(key)); map.set(key, next); return next },
      })
    }
    return tables.get(name)
  }
  return { name: DOMAIN.name, global: { get: () => global, set: async value => { global = value } }, table, close: async () => {} }
}
