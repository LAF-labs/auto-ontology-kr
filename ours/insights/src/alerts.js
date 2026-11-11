/**
 * Alert rules and their firings. A rule watches one value of one verified
 * saved analysis (fixed parameters, a value selector) and fires when a
 * threshold or a change against the previous period holds. The host
 * evaluates due rules on a timer with one run-batch request per tick and no
 * model. A rule fires on the evaluation where its condition becomes true and
 * again only after it was false; errors are recorded on the rule and never
 * fire. Rules an agent proposes start `pending` and run only after a person
 * turns them on. No harness imports.
 */
import { randomBytes } from 'node:crypto'
import { InsightsError, paramsProblems } from './reports.js'
import { formatValue, percentChange, pickValue, selectorProblems } from './values.js'

export const THRESHOLD_OPS = Object.freeze(['>', '>=', '<', '<='])
export const CHANGE_OPS = Object.freeze(['>=', '<=', 'abs>='])
export const RULE_STATUSES = Object.freeze(['pending', 'active', 'paused'])
const NAME_MAX = 120
const FIRINGS_MAX_DEFAULT = 1000

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Problems of a rule input; empty when valid. `limits.minIntervalS` and
 * `limits.maxIntervalS` bound `interval_s`.
 * @returns {Array<{path: string, message: string}>}
 */
export function ruleProblems(input, { minIntervalS, maxIntervalS }) {
  const problems = []
  const add = (path, message) => problems.push({ path, message })
  if (!isObject(input)) return [{ path: '$', message: 'must be an object' }]
  const allowed = ['name', 'analysis_id', 'version', 'params', 'value', 'condition', 'interval_s']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) add(`$.${key}`, 'unknown field')
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > NAME_MAX) add('$.name', `must be 1–${NAME_MAX} characters`)
  if (typeof input.analysis_id !== 'string' || input.analysis_id === '') add('$.analysis_id', 'must be a saved analysis id')
  if (input.version !== undefined && input.version !== null && !(Number.isInteger(input.version) && input.version >= 1)) add('$.version', 'must be a verified version number, or omitted to follow the latest verified version')
  problems.push(...paramsProblems(input.params, '$.params'))
  problems.push(...selectorProblems(input.value, '$.value'))
  const condition = input.condition
  if (!isObject(condition)) add('$.condition', 'must be an object')
  else if (condition.kind === 'threshold') {
    for (const key of Object.keys(condition)) if (!['kind', 'op', 'value'].includes(key)) add(`$.condition.${key}`, 'unknown field')
    if (!THRESHOLD_OPS.includes(condition.op)) add('$.condition.op', `must be one of ${THRESHOLD_OPS.join(' ')}`)
    if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) add('$.condition.value', 'must be a number')
  } else if (condition.kind === 'change') {
    for (const key of Object.keys(condition)) if (!['kind', 'op', 'percent', 'previous_params'].includes(key)) add(`$.condition.${key}`, 'unknown field')
    if (!CHANGE_OPS.includes(condition.op)) add('$.condition.op', `must be one of ${CHANGE_OPS.join(' ')}`)
    if (typeof condition.percent !== 'number' || !Number.isFinite(condition.percent)) add('$.condition.percent', 'must be a number (percent; -20 means a drop of 20 %)')
    if (condition.op === 'abs>=' && condition.percent < 0) add('$.condition.percent', 'abs>= takes a non-negative percent')
    if (!isObject(condition.previous_params) || Object.keys(condition.previous_params).length === 0) add('$.condition.previous_params', 'must give the parameters of the previous period (merged over params)')
    else problems.push(...paramsProblems(condition.previous_params, '$.condition.previous_params'))
  } else add('$.condition.kind', 'must be threshold or change')
  if (!(Number.isInteger(input.interval_s) && input.interval_s >= minIntervalS && input.interval_s <= maxIntervalS)) add('$.interval_s', `must be an integer from ${minIntervalS} to ${maxIntervalS} seconds`)
  return problems
}

/**
 * Whether the condition holds for `current` (and `previous` for change rules).
 * @returns {{matched: boolean, change_pct: number|null}}
 */
export function conditionHolds(condition, current, previous = null) {
  if (condition.kind === 'threshold') {
    const v = condition.value
    const matched = condition.op === '>' ? current > v : condition.op === '>=' ? current >= v : condition.op === '<' ? current < v : current <= v
    return { matched, change_pct: null }
  }
  const pct = percentChange(previous, current)
  if (pct === null) return { matched: false, change_pct: null }
  const matched = condition.op === '>=' ? pct >= condition.percent : condition.op === '<=' ? pct <= condition.percent : Math.abs(pct) >= condition.percent
  return { matched, change_pct: pct }
}

/** Human-readable condition, e.g. `> 1,000` or `직전 기간 대비 +20% 이상`. */
export function describeCondition(condition, locale = 'ko-KR') {
  if (condition.kind === 'threshold') return `${condition.op} ${formatValue(condition.value, { locale })}`
  const pct = formatValue(condition.percent, { format: 'change', locale })
  if (condition.op === 'abs>=') return `직전 기간 대비 ±${formatValue(condition.percent, { locale })}% 이상 변화`
  return condition.op === '>=' ? `직전 기간 대비 ${pct} 이상` : `직전 기간 대비 ${pct} 이하`
}

const newId = (prefix, now) => `${prefix}-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`

/**
 * Context handed to the analysis Session that "원인 분석" opens: the rule, the
 * firing and its provenance, as text with a JSON block the model can quote.
 */
export function investigationContext(firing) {
  const facts = {
    alert: firing.rule_name, fired_at: firing.fired_at, condition: firing.condition, condition_text: firing.condition_text,
    value: firing.value, value_text: firing.value_text, previous_value: firing.previous_value, change_pct: firing.change_pct,
    analysis: firing.analysis, params: firing.params, previous_params: firing.previous_params ?? null, value_selector: firing.selector,
    executed_at: firing.executed_at,
  }
  return JSON.stringify(facts, null, 2)
}

export class AlertStore {
  /**
   * @param {object} domain - opened storage domain with `rules` and `firings` tables.
   * @param {object} options
   * @param {{getAnalysis: Function, runBatch: Function}} options.connector
   * @param {number} options.maxRules - all rules, pending ones included.
   * @param {number} options.minIntervalS
   * @param {number} options.maxIntervalS
   * @param {number} [options.maxFirings] - newest kept.
   * @param {number} [options.deadlineS] - run-batch deadline_s per evaluation request.
   * @param {string} [options.locale]
   * @param {() => Date} [options.now]
   * @param {(firing: object) => void} [options.onFire] - host event hook, called after the firing is stored; it must not throw.
   */
  constructor(domain, { connector, maxRules, minIntervalS, maxIntervalS, maxFirings = FIRINGS_MAX_DEFAULT, deadlineS, locale = 'ko-KR', now = () => new Date(), onFire = () => {} }) {
    this.domain = domain
    this.connector = connector
    this.limits = { maxRules, minIntervalS, maxIntervalS }
    this.maxFirings = maxFirings
    this.deadlineS = deadlineS
    this.locale = locale
    this.now = now
    this.onFire = onFire
    this.evaluating = null
  }

  get rules() { return this.domain.table('rules') }
  get firings() { return this.domain.table('firings') }

  /**
   * Refuse rules on analyses without a verified version (or on an unverified
   * pinned version), unknown columns and unknown parameters.
   */
  async checkAnalysis(input, signal) {
    const result = await this.connector.getAnalysis(input.analysis_id, input.version == null ? {} : { version: input.version }, signal)
    if (!result.ok) throw new InsightsError(result.error.status === 404 ? 404 : 502, result.error.code === 'not_found' ? 'analysis_not_found' : 'analysis_unchecked', `could not read analysis ${input.analysis_id}: ${result.error.code}: ${result.error.message}`)
    const analysis = result.data
    const version = analysis.version
    if (input.version == null ? analysis.latest_verified_version == null : version?.status !== 'verified') {
      throw new InsightsError(409, 'not_verified', input.version == null
        ? `${analysis.name ?? input.analysis_id} has no verified version; alerts watch verified analyses only`
        : `${analysis.name ?? input.analysis_id} v${input.version} is ${version?.status ?? 'unknown'}, not verified; alerts watch verified analyses only`)
    }
    const columns = (version?.columns ?? []).map(column => column.name)
    const problems = []
    const wanted = [input.value.column, ...Object.keys(input.value.where ?? {})]
    for (const name of wanted) if (!columns.includes(name)) problems.push({ path: '$.value', message: `no result column ${name}; columns: ${columns.join(', ')}` })
    const names = (version?.params ?? []).map(param => param.name)
    const given = [...Object.keys(input.params ?? {}), ...Object.keys(input.condition?.previous_params ?? {})]
    for (const name of new Set(given)) if (!names.includes(name)) problems.push({ path: '$.params', message: `no parameter ${name}; parameters: ${names.join(', ') || '(none)'}` })
    if (problems.length > 0) throw new InsightsError(422, 'invalid_rule', 'the rule does not match the analysis', { problems })
    return { name: analysis.name ?? null, verified_version: input.version ?? analysis.latest_verified_version }
  }

  /**
   * @param {object} input - rule fields (see {@link ruleProblems}).
   * @param {{createdBy: 'person'|'agent', sessionId?: string|null, signal?: AbortSignal}} origin
   *   an agent's rule starts `pending`; a person's starts `active`.
   */
  async createRule(input, { createdBy, sessionId = null, signal } = {}) {
    const problems = ruleProblems(input, this.limits)
    if (problems.length > 0) throw new InsightsError(422, 'invalid_rule', 'the rule is not valid; nothing was saved', { problems })
    if (this.rules.size >= this.limits.maxRules) throw new InsightsError(409, 'rule_limit', `this server keeps at most ${this.limits.maxRules} alert rules; delete one first`, { max_rules: this.limits.maxRules })
    const checked = await this.checkAnalysis(input, signal)
    const now = this.now()
    const rule = {
      id: newId('al', now), name: input.name.trim(), analysis_id: input.analysis_id, analysis_name: checked.name,
      version: input.version ?? null, params: input.params ?? {}, value: input.value, condition: input.condition, interval_s: input.interval_s,
      status: createdBy === 'agent' ? 'pending' : 'active', created_by: createdBy, created_session_id: sessionId,
      created_at: now.toISOString(), updated_at: now.toISOString(),
      state: { matched: null, last_value: null, previous_value: null, change_pct: null, last_evaluated_at: null, last_executed_at: null, last_error: null, next_due_at: now.toISOString() },
    }
    await this.rules.put(rule.id, rule)
    return rule
  }

  getRule(id) {
    const rule = typeof id === 'string' ? this.rules.get(id) : undefined
    if (rule === undefined) throw new InsightsError(404, 'not_found', `no alert rule ${id}`)
    return rule
  }

  /**
   * A person's change: `status` (pending → active needs the analysis check again), or rule fields.
   * Field changes reset the evaluation state.
   */
  async updateRule(id, changes, signal) {
    const rule = this.getRule(id)
    const { status, ...fields } = changes ?? {}
    if (status !== undefined && !['active', 'paused'].includes(status)) throw new InsightsError(400, 'invalid_request', 'status must be active or paused')
    const merged = { name: rule.name, analysis_id: rule.analysis_id, ...rule.version === null ? {} : { version: rule.version }, params: rule.params, value: rule.value, condition: rule.condition, interval_s: rule.interval_s, ...fields }
    const problems = ruleProblems(merged, this.limits)
    if (problems.length > 0) throw new InsightsError(422, 'invalid_rule', 'the rule is not valid; nothing changed', { problems })
    const changedFields = Object.keys(fields).length > 0
    const checked = changedFields || status === 'active' ? await this.checkAnalysis(merged, signal) : { name: rule.analysis_name }
    const now = this.now().toISOString()
    const next = {
      ...rule, name: merged.name.trim(), analysis_id: merged.analysis_id, analysis_name: checked.name, version: merged.version ?? null,
      params: merged.params ?? {}, value: merged.value, condition: merged.condition, interval_s: merged.interval_s,
      status: status ?? rule.status, updated_at: now,
      state: changedFields || (status === 'active' && rule.status !== 'active')
        ? { ...rule.state, matched: changedFields ? null : rule.state.matched, last_error: null, next_due_at: now }
        : rule.state,
    }
    await this.rules.put(id, next)
    return next
  }

  async deleteRule(id) {
    this.getRule(id)
    await this.rules.delete(id)
    return { id, deleted: true }
  }

  listRules() {
    return [...this.rules.entries()].map(([, r]) => r).sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  /** Newest first. */
  listFirings({ limit = 50, offset = 0, unread_only = false, rule_id } = {}) {
    let rows = [...this.firings.entries()].map(([, f]) => f)
    if (unread_only) rows = rows.filter(f => f.read_at === null)
    if (rule_id !== undefined) rows = rows.filter(f => f.rule_id === rule_id)
    rows.sort((a, b) => b.fired_at.localeCompare(a.fired_at) || b.id.localeCompare(a.id))
    return { data: rows.slice(offset, offset + limit), total: rows.length, unread: this.unreadCount() }
  }

  unreadCount() {
    let count = 0
    for (const [, f] of this.firings.entries()) if (f.read_at === null) count += 1
    return count
  }

  getFiring(id) {
    const firing = typeof id === 'string' ? this.firings.get(id) : undefined
    if (firing === undefined) throw new InsightsError(404, 'not_found', `no alert firing ${id}`)
    return firing
  }

  /** Mark firings read: the given ids, or all when `ids` is undefined. */
  async markRead(ids) {
    const at = this.now().toISOString()
    let changed = 0
    for (const [key, f] of [...this.firings.entries()]) {
      if (f.read_at !== null || (ids !== undefined && !ids.includes(key))) continue
      await this.firings.put(key, { ...f, read_at: at })
      changed += 1
    }
    return { marked: changed, unread: this.unreadCount() }
  }

  async setInvestigation(firingId, sessionId) {
    const firing = this.getFiring(firingId)
    const next = { ...firing, investigation_session_id: sessionId, read_at: firing.read_at ?? this.now().toISOString() }
    await this.firings.put(firingId, next)
    return next
  }

  /** Active rules whose next evaluation time has come. */
  dueRules(now = this.now()) {
    return this.listRules().filter(rule => rule.status === 'active' && Date.parse(rule.state.next_due_at ?? 0) <= now.getTime())
  }

  /**
   * Evaluate every due rule with run-batch (50 items per request). Passes run
   * one at a time, so a rule never fires twice for one transition.
   * @returns {Promise<{evaluated: number, fired: number, errors: number, requests: number}>}
   */
  evaluateDue(signal) {
    return this.serial(() => this.evaluate(this.dueRules(), signal))
  }

  /** Evaluate one rule now, whatever its next due time (a person's "evaluate now"; paused and pending rules too). */
  evaluateRule(id, signal) {
    this.getRule(id)
    return this.serial(() => this.evaluate([this.getRule(id)], signal))
  }

  serial(task) {
    const run = (this.evaluating ?? Promise.resolve()).then(task)
    const tail = run.then(() => {}, () => {}) // the caller sees the failure through `run`; the queue only waits for it
    this.evaluating = tail
    tail.then(() => { if (this.evaluating === tail) this.evaluating = null })
    return run
  }

  async evaluate(rules, signal) {
    const summary = { evaluated: 0, fired: 0, errors: 0, requests: 0 }
    if (rules.length === 0) return summary
    const items = []
    for (const rule of rules) {
      const base = { analysis_id: rule.analysis_id, ...rule.version === null ? {} : { version: rule.version }, max_age_s: rule.interval_s }
      items.push({ key: `cur:${rule.id}`, ...base, params: rule.params })
      if (rule.condition.kind === 'change') items.push({ key: `prev:${rule.id}`, ...base, params: { ...rule.params, ...rule.condition.previous_params } })
    }
    const results = {}
    for (let start = 0; start < items.length; start += 50) {
      const chunk = items.slice(start, start + 50)
      summary.requests += 1
      const response = await this.connector.runBatch({ items: chunk, ...this.deadlineS === undefined ? {} : { deadline_s: this.deadlineS } }, signal)
      for (const item of chunk) results[item.key] = response.ok ? response.data[item.key] : response
    }
    for (const rule of rules) {
      summary.evaluated += 1
      const fired = await this.applyResult(rule, results[`cur:${rule.id}`], rule.condition.kind === 'change' ? results[`prev:${rule.id}`] : undefined)
      if (fired === 'error') summary.errors += 1
      if (fired === 'fired') summary.fired += 1
    }
    return summary
  }

  readNumber(rule, result) {
    if (result === undefined || !result.ok) return { error: { code: result?.error?.code ?? 'missing', message: result?.error?.message ?? 'no result' } }
    const data = result.data
    if (data.status !== 'verified') return { error: { code: 'not_verified', message: `${data.name ?? rule.analysis_id} v${data.version} is ${data.status}; alerts read verified versions only` } }
    const picked = pickValue(data, rule.value)
    if (!picked.ok) return { error: { code: picked.code, message: picked.message } }
    if (picked.number === null) return { error: { code: 'not_numeric', message: `${rule.value.column} is not numeric: ${JSON.stringify(picked.value)}` } }
    return { number: picked.number, data, column: picked.column }
  }

  async applyResult(rule, current, previous) {
    const now = this.now()
    const nextDue = new Date(now.getTime() + rule.interval_s * 1000).toISOString()
    const cur = this.readNumber(rule, current)
    const prev = previous === undefined ? undefined : this.readNumber(rule, previous)
    const failure = cur.error ?? prev?.error
    const latest = this.rules.get(rule.id)
    if (latest === undefined || latest.updated_at !== rule.updated_at) return 'skipped'
    if (failure !== undefined) {
      await this.rules.put(rule.id, { ...latest, state: { ...latest.state, last_evaluated_at: now.toISOString(), last_error: { ...failure, at: now.toISOString() }, next_due_at: nextDue } })
      return 'error'
    }
    const { matched, change_pct } = conditionHolds(rule.condition, cur.number, prev?.number ?? null)
    const fire = matched && latest.state.matched !== true
    await this.rules.put(rule.id, {
      ...latest,
      state: {
        matched, last_value: cur.number, previous_value: prev?.number ?? null, change_pct,
        last_evaluated_at: now.toISOString(), last_executed_at: cur.data.executed_at ?? null, last_error: null, next_due_at: nextDue,
      },
    })
    if (!fire) return 'evaluated'
    const unit = cur.column?.unit ?? null
    const firing = {
      id: newId('af', now), rule_id: rule.id, rule_name: rule.name, fired_at: now.toISOString(),
      condition: rule.condition, condition_text: describeCondition(rule.condition, this.locale),
      value: cur.number, value_text: formatValue(cur.number, { unit, locale: this.locale }),
      previous_value: prev?.number ?? null, previous_value_text: prev === undefined ? null : formatValue(prev.number, { unit, locale: this.locale }),
      change_pct, change_text: change_pct === null ? null : formatValue(change_pct, { format: 'change', locale: this.locale }),
      column: { name: cur.column?.name ?? null, label: cur.column?.label ?? null, unit },
      selector: rule.value,
      analysis: { id: cur.data.analysis_id, name: cur.data.name ?? null, version: cur.data.version, status: cur.data.status, verified: cur.data.status === 'verified' },
      params: cur.data.params ?? rule.params, previous_params: prev?.data.params ?? null,
      executed_at: cur.data.executed_at ?? null, read_at: null, investigation_session_id: null,
    }
    await this.firings.put(firing.id, firing)
    await this.pruneFirings()
    this.onFire(firing)
    return 'fired'
  }

  async pruneFirings() {
    if (this.firings.size <= this.maxFirings) return
    const ordered = [...this.firings.entries()].map(([, f]) => f).sort((a, b) => a.fired_at.localeCompare(b.fired_at))
    for (const firing of ordered.slice(0, ordered.length - this.maxFirings)) await this.firings.delete(firing.id)
  }
}
