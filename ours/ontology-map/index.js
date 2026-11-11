/**
 * Host plugin of @ours/ontology-map: registers the read-only data map routes
 * (see src/routes.js) on the shared API channel. The browser never calls the
 * Auto-ontology gateway; these routes do, through `ctx.aoConnector` and its
 * read token. The client half (client.js) is the 데이터 지도 panel.
 */
import z from '@deepseek-ai/schemastery'
import { ontologyMapRoutes } from './src/routes.js'

export const name = 'ontology-map'
export const inject = ['connection', 'aoConnector']

export const Config = z.object({
  cacheTtlS: z.natural().default(300).description('Seconds a read map is reused before the gateway is read again (다시 불러오기 always reads again).'),
  maxEntities: z.natural().min(1).max(500).default(500).description('semantic-graph limit; the gateway caps it at 500.'),
  mainCount: z.natural().min(1).default(12).description('Entities shown before 모두 보기: the most linked ones, confirmed analyses counting extra.'),
})

export function apply(ctx, config) {
  const routes = ontologyMapRoutes({ connector: ctx.aoConnector, cacheTtlS: config.cacheTtlS, maxEntities: config.maxEntities, mainCount: config.mainCount })
  for (const route of routes) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => dispose()
    }, `ontology-map: ${route.path}`)
  }
}
