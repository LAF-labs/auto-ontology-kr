/**
 * Host service `ctx.dashboardStore`: dashboard specs, widget modules and
 * publish pointers in the `ours_dashboard` storage domain, plus edit Sessions.
 * Browser routes are the `./http` row; the browser runtime is this package's
 * client half; the editing tools and the widget skill are preset rows
 * (`./editor-tools`, `./widget-skill`).
 *
 * Publishing checks every analysis the draft reads against Auto-ontology
 * (`ctx.aoConnector`) and refuses unverified ones.
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DOMAIN, DashboardStore, StoreError } from './src/store.js'
import { makeAnalysisGate } from './src/editor.js'

export default class DashboardStoreService extends Service {
  static inject = ['storageDomain', 'aoConnector']

  static Config = z.object({
    batchDeadlineS: z.natural().min(1).max(280).description('deadline_s the browser runtime sends with each run-batch. Leave unset for Auto-ontology backends that predate deadline_s.'),
    maxBatchItems: z.natural().min(1).max(50).default(50).description('Widgets per run-batch request; the contract allows 50.'),
    editorPreset: z.string().default('dashboard-editor').description('Agent preset of the Session the dashboard edit button opens.'),
    editorCwd: z.string().description('Directory of edit Sessions. They join no Workspace, so New Session never reuses one under another preset. Use an empty directory outside any repository: skill discovery reads the project of this directory. Unset uses the Session Controller default.'),
    editorTitle: z.string().default('대시보드 수정: {title}').description('Title given to a new edit Session; {title} is the dashboard title.'),
    editorFirstPrompt: z.string().default('대시보드 "{title}" 초안을 고치려고 합니다. 초안을 읽고 지금 구성을 두세 줄로 알려 주세요.').description('First message sent into a new edit Session ({title} is the dashboard title); its turn makes the Session non-blank, which the conversation needs to accept input outside a Workspace. Costs one agent turn. Empty sends nothing.'),
  })

  constructor(ctx, config) {
    super(ctx, 'dashboardStore')
    this.config = config
    this.store = undefined
    this.gate = makeAnalysisGate(ctx.aoConnector)
  }

  async [Service.init]() {
    if (this.config.editorCwd !== undefined) await mkdir(this.config.editorCwd, { recursive: true, mode: 0o700 })
    const domain = await this.ctx.storageDomain.open(DOMAIN)
    this.ctx.effect(() => () => domain.close(), 'dashboard-store: domain')
    this.store = new DashboardStore(domain, { checkAnalyses: this.gate })
  }

  /** Settings the browser runtime reads with the dashboard list. */
  runtimeSettings() {
    return {
      ...this.config.batchDeadlineS === undefined ? {} : { deadline_s: this.config.batchDeadlineS },
      max_batch_items: this.config.maxBatchItems,
    }
  }

  /** Add an immutable widget module version. Host seeding packages pass `origin: 'basic'`. */
  putWidget(widget) { return this.store.putWidget(widget) }

  /**
   * Start an edit Session on `owner`'s draft of dashboard `id`: the draft is
   * copied from the published version when the owner has none, a new Session
   * runs the editor preset outside every Workspace, the binding is stored, and
   * the first message starts a turn before the Session id is returned. A
   * Session outside a Workspace takes input only once it is not blank, and a
   * Session that is not blank is never reused by New Session.
   * @returns {Promise<{ session_id: string, dashboard_id: string, draft: object }>}
   */
  async openEditor(id, owner) {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new StoreError(503, 'editing_unavailable', 'this server has no Session Controller')
    const draft = await this.store.saveDraft(id, owner)
    let created
    try {
      created = await controller.create({
        ...this.config.editorCwd === undefined ? {} : { cwd: this.config.editorCwd },
        agentPreset: this.config.editorPreset,
      })
    } catch (error) {
      throw new StoreError(502, 'session_create_failed', `could not start an edit session: ${error?.message ?? String(error)}`)
    }
    if (created.agentPreset !== undefined && created.agentPreset !== this.config.editorPreset) {
      throw new StoreError(500, 'session_create_failed', `the edit session runs preset ${created.agentPreset}, not ${this.config.editorPreset}`)
    }
    await this.store.bindEditor(created.sessionId, id, owner)
    try {
      await controller.rename({ sessionId: created.sessionId, title: this.config.editorTitle.replace('{title}', draft.spec.title) })
    } catch (error) {
      this.ctx.logger.warn(`dashboard-store: edit session ${created.sessionId} keeps its default title: ${error?.message ?? String(error)}`)
    }
    if (this.config.editorFirstPrompt !== '') {
      try {
        await controller.prompt({
          requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue',
          content: [{ type: 'text', text: this.config.editorFirstPrompt.replace('{title}', draft.spec.title) }],
        }, AbortSignal.timeout(30_000))
      } catch (error) {
        throw new StoreError(502, 'session_prompt_failed', `the edit session ${created.sessionId} was created but did not start: ${error?.message ?? String(error)}`, { session_id: created.sessionId })
      }
    }
    return { session_id: created.sessionId, dashboard_id: id, draft }
  }
}
