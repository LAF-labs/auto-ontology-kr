/**
 * Host service `ctx.aoConnector`: the Auto-ontology gateway client bound to
 * this deployment's base URL and API tokens: a read token, an optional editor
 * token for saving draft analyses (agent tools), and an optional reviewer token
 * for recording a person's verification (the edit panel's button only). Each token is a credential
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
    editorKeyEnv: z.string().default('AUTO_ONTOLOGY_EDITOR_TOKEN').description('Credential reference naming the token with analysis:manage (role analysis_editor), used only to save draft analyses. Unset leaves saving failing with missing_token.'),
    reviewerKeyEnv: z.string().default('AUTO_ONTOLOGY_REVIEWER_TOKEN').description('Credential reference naming the token with analysis:verify (role analysis_reviewer), used only by the person-facing verify route. Unset leaves verifying failing with missing_token.'),
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
      editorToken: async () => (await credentials.resolve(config.editorKeyEnv))?.value,
      reviewerToken: async () => (await credentials.resolve(config.reviewerKeyEnv))?.value,
    })
  }

  listAnalyses(query, signal) { return this.client.listAnalyses(query, signal) }
  getAnalysis(analysisId, options, signal) { return this.client.getAnalysis(analysisId, options, signal) }
  runAnalysis(analysisId, request, signal) { return this.client.runAnalysis(analysisId, request, signal) }
  runBatch(request, signal) { return this.client.runBatch(request, signal) }
  searchTerms(searchTerm, options, signal) { return this.client.searchTerms(searchTerm, options, signal) }
  questionCoverage(question, options, signal) { return this.client.questionCoverage(question, options, signal) }
  askQuestion(question, options, signal) { return this.client.askQuestion(question, options, signal) }
  createAnalysis(request, signal) { return this.client.createAnalysis(request, signal) }
  addVersion(analysisId, request, signal) { return this.client.addVersion(analysisId, request, signal) }
  verifyVersion(analysisId, version, options, signal) { return this.client.verifyVersion(analysisId, version, options, signal) }
}
