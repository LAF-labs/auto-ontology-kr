/**
 * Host service `ctx.dashboardStore`: dashboard specs, widget modules and
 * publish pointers in the `ours_dashboard` storage domain. Browser routes are
 * the `./http` row; the browser runtime is this package's client half.
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DOMAIN, DashboardStore } from './src/store.js'

export default class DashboardStoreService extends Service {
  static inject = ['storageDomain']

  static Config = z.object({
    batchDeadlineS: z.natural().min(1).max(280).description('deadline_s the browser runtime sends with each run-batch. Leave unset for Auto-ontology backends that predate deadline_s.'),
    maxBatchItems: z.natural().min(1).max(50).default(50).description('Widgets per run-batch request; the contract allows 50.'),
  })

  constructor(ctx, config) {
    super(ctx, 'dashboardStore')
    this.config = config
    this.store = undefined
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(DOMAIN)
    this.ctx.effect(() => () => domain.close(), 'dashboard-store: domain')
    this.store = new DashboardStore(domain)
  }

  /** Settings the browser runtime reads with the dashboard list. */
  runtimeSettings() {
    return {
      ...this.config.batchDeadlineS === undefined ? {} : { deadline_s: this.config.batchDeadlineS },
      max_batch_items: this.config.maxBatchItems,
    }
  }

  /** Add an immutable widget module version (seeding packages call this). */
  putWidget(widget) { return this.store.putWidget(widget) }
}
