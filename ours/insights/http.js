/** Registers the /api/insights/* browser routes (see src/routes.js) on the shared API channel. */
import { insightsRoutes } from './src/routes.js'

export const name = 'insights-http'
export const inject = ['connection', 'insights']

export function apply(ctx) {
  const service = ctx.insights
  const routes = insightsRoutes({ reports: service.reports, alerts: service.alerts, investigate: id => service.investigate(id), limits: service.limits,
    schedules: { list: () => service.scheduleRows(), setActive: (id, active) => service.setScheduleActive(id, active) } })
  for (const route of routes) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => dispose()
    }, `insights-http: ${route.path}`)
  }
}
