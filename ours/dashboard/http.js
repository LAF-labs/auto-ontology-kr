/** Registers the /api/dashboard/* browser routes (see src/routes.js) on the shared API channel. */
import { dashboardRoutes } from './src/routes.js'

export const name = 'dashboard-http'
export const inject = ['connection', 'dashboardStore']

export function apply(ctx) {
  for (const route of dashboardRoutes(ctx.dashboardStore.store, ctx.dashboardStore.runtimeSettings())) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => dispose()
    }, `dashboard-http: ${route.path}`)
  }
}
