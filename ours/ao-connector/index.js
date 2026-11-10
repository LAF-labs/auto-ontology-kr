/**
 * Host service `ctx.aoConnector`: the Auto-ontology gateway client bound to
 * this deployment's base URL and API token. The token is a credential
 * reference resolved on every request (credential store first, then the
 * launching environment), so rotating it needs no restart. Agent tools
 * (`./tools`) and browser routes (`./http`) call the same methods.
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AoClient } from './src/client.js'

export default class AoConnector extends Service {
  static inject = ['credentials']

  static Config = z.object({
    baseUrl: z.string().required().description('Gateway origin (Next.js tier), without /api.'),
    apiKeyEnv: z.string().default('AUTO_ONTOLOGY_API_TOKEN').description('Credential reference naming the API token.'),
    requestTimeoutMs: z.natural().min(1).default(330000).description('Deadline for one JSON request. Covers the 300 s analysis timeout plus the 10 s queue wait.'),
    askTimeoutMs: z.natural().min(1).default(900000).description('Deadline for one streamed question.'),
  })

  constructor(ctx, config) {
    super(ctx, 'aoConnector')
    const credentials = ctx.credentials
    this.client = new AoClient({
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      askTimeoutMs: config.askTimeoutMs,
      token: async () => (await credentials.resolve(config.apiKeyEnv))?.value,
    })
  }

  listAnalyses(query, signal) { return this.client.listAnalyses(query, signal) }
  getAnalysis(analysisId, options, signal) { return this.client.getAnalysis(analysisId, options, signal) }
  runAnalysis(analysisId, request, signal) { return this.client.runAnalysis(analysisId, request, signal) }
  runBatch(request, signal) { return this.client.runBatch(request, signal) }
  searchTerms(searchTerm, options, signal) { return this.client.searchTerms(searchTerm, options, signal) }
  questionCoverage(question, options, signal) { return this.client.questionCoverage(question, options, signal) }
  askQuestion(question, options, signal) { return this.client.askQuestion(question, options, signal) }
}
