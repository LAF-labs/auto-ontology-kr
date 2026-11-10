/** Registers the /api/ao/* browser routes (see src/http-routes.js) on the shared API channel. */
import { aoRoutes } from './src/http-routes.js'

export const name = 'ao-connector-http'
export const inject = ['connection', 'aoConnector']

export function apply(ctx) {
  for (const route of aoRoutes(ctx.aoConnector)) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => dispose()
    }, `ao-connector-http: ${route.path}`)
  }
}
