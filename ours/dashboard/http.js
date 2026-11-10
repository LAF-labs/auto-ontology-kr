/** Registers the /api/dashboard/* browser routes (see src/routes.js) on the shared API channel. */
import { dashboardRoutes } from './src/routes.js'

export const name = 'dashboard-http'
export const inject = ['connection', 'dashboardStore']

export function apply(ctx) {
  const service = ctx.dashboardStore
  const editing = { openEditor: (id, owner) => service.openEditor(id, owner), gate: service.gate }
  for (const route of dashboardRoutes(service.store, service.runtimeSettings(), editing)) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => dispose()
    }, `dashboard-http: ${route.path}`)
  }
}
