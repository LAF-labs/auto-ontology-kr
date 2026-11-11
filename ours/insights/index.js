/**
 * Host service `ctx.insights`: reports and alert rules in the `ours_insights`
 * storage domain, the alert evaluation timer, and the analysis Session that a
 * firing's "원인 분석" button opens. Browser routes are the `./http` row, the
 * agent tools the `./tools` preset row, and the Reports and Alerts panels
 * this package's client half.
 *
 * Evaluation runs saved analyses through `ctx.aoConnector.runBatch` and never
 * calls a model. A model runs only in Sessions: the analysis Session a
 * person opens from a firing, and Sessions the Host Schedule service starts.
 *
 * Host events for later delivery (mail, messenger), emitted after the record
 * is stored, with listeners run in parallel and their failures logged:
 *   `ours-insights/report-saved` (report)   `ours-insights/alert-fired` (firing)
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AlertStore, investigationContext } from './src/alerts.js'
import { InsightsError, ReportStore } from './src/reports.js'
import { reportTrigger } from './src/trigger.js'

/** Storage-domain spec (plain object; `ctx.storageDomain.open` accepts it as `defineDomain` would return it). */
export const DOMAIN = Object.freeze({
  name: 'ours_insights',
  version: 1,
  global: { schema: { parse: value => value, safeParse: value => ({ success: value !== null && typeof value === 'object' }) }, initial: {} },
  tables: {
    reports: { valueSchema: { parse: value => value } },
    rules: { valueSchema: { parse: value => value } },
    firings: { valueSchema: { parse: value => value } },
  },
})

export const REPORT_SAVED = 'ours-insights/report-saved'
export const ALERT_FIRED = 'ours-insights/alert-fired'

export default class InsightsService extends Service {
  static inject = ['storageDomain', 'aoConnector']

  static Config = z.object({
    locale: z.string().default('ko-KR').description('Locale of stored value texts (figures, firings).'),
    maxReports: z.natural().min(1).default(5000).description('Reports kept; saving beyond it removes the oldest.'),
    figureMaxAgeS: z.natural().default(3600).description('Cache age accepted when the host reads report figure values; the agent ran the same analyses moments before.'),
    maxRules: z.natural().min(1).max(500).default(20).description('Alert rules kept, pending ones included.'),
    minIntervalS: z.natural().min(60).default(300).description('Shortest evaluation interval a rule may ask for.'),
    maxIntervalS: z.natural().min(60).default(604800).description('Longest evaluation interval.'),
    maxFirings: z.natural().min(1).default(1000).description('Firings kept; the oldest are removed.'),
    tickS: z.natural().min(5).default(30).description('How often the host looks for due rules.'),
    batchDeadlineS: z.natural().min(1).max(280).description('run-batch deadline_s per evaluation request. Leave unset for Auto-ontology backends without deadline_s.'),
    investigationPreset: z.string().default('analyst').description('Agent preset of the Session a firing\'s "원인 분석" button opens.'),
    investigationCwd: z.string().description('Directory of those Sessions (no Workspace, so New Session never reuses one). Unset uses the Session Controller default.'),
    investigationTitle: z.string().default('알림 원인 분석: {name}').description('Title of that Session; {name} is the rule name.'),
    investigationPrompt: z.string().default([
      '알림 "{name}"이(가) 발생했습니다. 원인을 분석해 주세요.',
      '저장된 분석(ao_list_analyses, ao_get_analysis, ao_run_analysis)으로 이 값을 다시 확인하고, 기간이나 구분을 바꿔 무엇이 달라졌는지 찾으세요.',
      '숫자는 실행 결과에서 읽은 것만 쓰고, 분석 이름과 버전, 파라미터, 실행 시각을 함께 적으세요.',
      '',
      '알림 정보(호스트가 기록한 값):',
      '```json',
      '{context}',
      '```',
    ].join('\n')).description('First message of that Session; {name} is the rule name and {context} the firing as JSON. The model runs from this message on.'),
  })

  constructor(ctx, config) {
    super(ctx, 'insights')
    this.config = config
    this.limits = { max_rules: config.maxRules, min_interval_s: config.minIntervalS, max_interval_s: config.maxIntervalS, tick_s: config.tickS }
    this.reports = undefined
    this.alerts = undefined
    this.timer = undefined
    this.stopped = false
  }

  async [Service.init]() {
    if (this.config.investigationCwd !== undefined) await mkdir(this.config.investigationCwd, { recursive: true, mode: 0o700 })
    const domain = await this.ctx.storageDomain.open(DOMAIN)
    this.ctx.effect(() => () => domain.close(), 'insights: domain')
    this.reports = new ReportStore(domain, { connector: this.ctx.aoConnector, maxReports: this.config.maxReports, maxAgeS: this.config.figureMaxAgeS, locale: this.config.locale })
    this.alerts = new AlertStore(domain, {
      connector: this.ctx.aoConnector,
      maxRules: this.config.maxRules, minIntervalS: this.config.minIntervalS, maxIntervalS: this.config.maxIntervalS,
      maxFirings: this.config.maxFirings, deadlineS: this.config.batchDeadlineS, locale: this.config.locale,
      onFire: firing => this.announce(ALERT_FIRED, firing),
    })
    this.ctx.effect(() => {
      this.stopped = false
      this.schedule(1000)
      return () => { this.stopped = true; clearTimeout(this.timer) }
    }, 'insights: alert timer')
  }

  /** Run host event listeners without waiting; log their failures. */
  announce(event, record) {
    this.ctx.parallel(event, record).catch(error => this.ctx.logger.warn(`insights: ${event} listener failed: ${error?.message ?? String(error)}`))
  }

  schedule(delayMs) {
    if (this.stopped) return
    this.timer = setTimeout(() => this.tick(), delayMs)
    this.timer.unref?.()
  }

  async tick() {
    try {
      const summary = await this.alerts.evaluateDue()
      if (summary.evaluated > 0) this.ctx.logger.info(`insights: evaluated ${summary.evaluated} rule(s), ${summary.fired} fired, ${summary.errors} error(s), ${summary.requests} run-batch request(s)`)
    } catch (error) {
      this.ctx.logger.warn(`insights: alert evaluation failed: ${error?.message ?? String(error)}`)
    } finally {
      this.schedule(this.config.tickS * 1000)
    }
  }

  /** What started Session `sessionId` (see src/trigger.js). */
  triggerOf(sessionId, hintId) {
    return reportTrigger(this.ctx.get('schedule'), sessionId, hintId)
  }

  /** Called by the report tool after a report is stored. */
  reportSaved(report) {
    this.announce(REPORT_SAVED, report)
  }

  /**
   * Open the analysis Session for a firing, or return the one opened before
   * (no model call then). The first message carries the firing as JSON.
   * @returns {Promise<{session_id: string, reused: boolean}>}
   */
  async investigate(firingId) {
    const firing = this.alerts.getFiring(firingId)
    if (firing.investigation_session_id !== null) {
      await this.alerts.markRead([firing.id])
      return { session_id: firing.investigation_session_id, reused: true }
    }
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new InsightsError(503, 'sessions_unavailable', 'this server has no Session Controller')
    let created
    try {
      created = await controller.create({
        ...this.config.investigationCwd === undefined ? {} : { cwd: this.config.investigationCwd },
        agentPreset: this.config.investigationPreset,
      })
    } catch (error) {
      throw new InsightsError(502, 'session_create_failed', `could not start the analysis session: ${error?.message ?? String(error)}`)
    }
    await this.alerts.setInvestigation(firing.id, created.sessionId)
    try {
      await controller.rename({ sessionId: created.sessionId, title: this.config.investigationTitle.replace('{name}', firing.rule_name) })
    } catch (error) {
      this.ctx.logger.warn(`insights: session ${created.sessionId} keeps its default title: ${error?.message ?? String(error)}`)
    }
    const text = this.config.investigationPrompt.replaceAll('{name}', firing.rule_name).replace('{context}', investigationContext(firing))
    try {
      await controller.prompt({ requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(30_000))
    } catch (error) {
      throw new InsightsError(502, 'session_prompt_failed', `the analysis session ${created.sessionId} was created but did not start: ${error?.message ?? String(error)}`, { session_id: created.sessionId })
    }
    return { session_id: created.sessionId, reused: false }
  }
}
