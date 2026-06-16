import {
  ToolMessage,
  type ConnectorId,
  type ConnectorInput,
  type ConnectorOutput,
  type WorkflowContext,
  type WorkflowStepController,
  workflow,
  z,
} from "@pac/workflow";
import type { OpenWebIntelligenceConnectorCatalog } from "../connectors/main.js";

const ResearchStatusSchema = z.enum([
  "collecting",
  "awaiting_confirmation",
  "researching",
  "ready",
  "cancelled",
]);

const ResearchScenarioSchema = z.enum([
  "competitor_landscape",
  "competitor_profile",
  "market_trend_brief",
  "pricing_positioning_compare",
  "website_signal_audit",
  "deep_research_report",
]);

const RecencySchema = z.enum(["day", "week", "month", "year"]);
const OutputFormatSchema = z.enum(["brief", "matrix", "report", "watchlist"]);
const BlockerSchema = z.enum([
  "missing_subject",
  "missing_website",
  "needs_site_crawl_confirmation",
  "needs_deep_research_confirmation",
  "evidence_unavailable",
]);

const ResearchTaskSchema = z.object({
  requestId: z.string(),
  createdAt: z.string(),
  status: z.string(),
  input: z.string(),
  model: z.string(),
});

const ResearchStateSchema = z.object({
  status: ResearchStatusSchema,
  scenario: ResearchScenarioSchema.nullable(),
  subject: z.string().nullable(),
  purpose: z.string().nullable(),
  region: z.string().nullable(),
  language: z.string().nullable(),
  recency: RecencySchema.nullable(),
  outputFormat: OutputFormatSchema.nullable(),
  competitors: z.array(z.string()),
  websites: z.array(z.string()),
  siteCrawlRequested: z.boolean(),
  siteCrawlConfirmed: z.boolean(),
  deepResearchRequested: z.boolean(),
  deepResearchConfirmed: z.boolean(),
  researchTask: ResearchTaskSchema.nullable(),
  blocker: BlockerSchema.nullable(),
});

export type ResearchState = z.infer<typeof ResearchStateSchema>;

type WebContext = WorkflowContext<OpenWebIntelligenceConnectorCatalog>;
type WebConnectorId = ConnectorId<OpenWebIntelligenceConnectorCatalog>;
type Recency = z.infer<typeof RecencySchema>;

const initialState = ResearchStateSchema.parse({
  status: "collecting",
  scenario: null,
  subject: null,
  purpose: null,
  region: null,
  language: null,
  recency: null,
  outputFormat: null,
  competitors: [],
  websites: [],
  siteCrawlRequested: false,
  siteCrawlConfirmed: false,
  deepResearchRequested: false,
  deepResearchConfirmed: false,
  researchTask: null,
  blocker: null,
});

const invalidation = {
  scenario: ["siteCrawlConfirmed", "deepResearchConfirmed", "researchTask", "blocker"],
  subject: ["siteCrawlConfirmed", "deepResearchConfirmed", "researchTask", "blocker"],
  purpose: ["siteCrawlConfirmed", "deepResearchConfirmed", "researchTask", "blocker"],
  region: ["deepResearchConfirmed", "researchTask", "blocker"],
  language: ["deepResearchConfirmed", "researchTask", "blocker"],
  recency: ["deepResearchConfirmed", "researchTask", "blocker"],
  outputFormat: ["deepResearchConfirmed", "researchTask", "blocker"],
  competitors: ["deepResearchConfirmed", "researchTask", "blocker"],
  websites: ["siteCrawlConfirmed", "deepResearchConfirmed", "researchTask", "blocker"],
  siteCrawlRequested: ["siteCrawlConfirmed", "blocker"],
  deepResearchRequested: ["deepResearchConfirmed", "researchTask", "blocker"],
} satisfies Partial<Record<keyof ResearchState & string, Array<keyof ResearchState & string>>>;

const { patch, effect, render } = workflow<
  ResearchState,
  OpenWebIntelligenceConnectorCatalog
>({
  stateSchema: ResearchStateSchema,
  state: initialState,
  invalidation,
});

patch({
  progress: "正在理解调研口径",
  state: {
    status: ResearchStatusSchema.describe("Set cancelled only for explicit cancellation. Set researching when the user provides or changes the research request. Do not set ready."),
    scenario: ResearchScenarioSchema.describe("Best matching business branch from the procedure."),
    subject: z.string().describe("Main company, product, brand, market, industry, technology, or research topic named by the user."),
    purpose: z.string().describe("User-stated decision purpose, such as product positioning, sales strategy, market entry, competitor discovery, pricing comparison, or trend tracking."),
    region: z.string().describe("User-stated geography or market scope."),
    language: z.string().describe("User-stated language scope."),
    recency: RecencySchema.describe("User-stated time sensitivity normalized to day, week, month, or year."),
    outputFormat: OutputFormatSchema.describe("User-requested output style: brief, matrix, report, or watchlist."),
    competitors: z.array(z.string()).describe("Explicit company/product/brand competitors named by the user."),
    websites: z.array(z.string()).describe("Explicit public websites, domains, or URLs named by the user."),
    siteCrawlRequested: z.boolean().describe("True only when the user asks for a broad website audit, site crawl, or systematic site analysis."),
    siteCrawlConfirmed: z.boolean().describe("True only when the user confirms the assistant should crawl public pages for the current scope."),
    deepResearchRequested: z.boolean().describe("True only when the user asks for deep research, full report, comprehensive investigation, or evidence-chain report."),
    deepResearchConfirmed: z.boolean().describe("True only when the user confirms starting deep research for the current scope."),
  },
  invalidates: invalidation,
  instruction: `
Extract only user-expressed competitor and market research facts from the latest user message.
Do not reply to the user. Do not call connectors. Do not invent competitors, websites, facts, prices, market size, users, revenue, funding, or product capabilities.

Research subject and scope:
- subject is the main company, product, website, industry, market, technology, or research question named by the user.
- purpose captures why the user wants the research, for example direct competitor discovery, product positioning, sales strategy, market entry, pricing comparison, trend tracking, or partner/investment screening.
- region, language, recency, and outputFormat are set only when directly expressed.
- If the user says latest/today/current, set recency to day unless they specify a wider period. If they say this week, set week; recent/month, set month; this year/last 12 months, set year.

Scenario:
- competitor_landscape for competitor discovery or alternative/player lists.
- competitor_profile for one or more named competitor profiles.
- market_trend_brief for market trend, recent events, industry opportunity, or risk.
- pricing_positioning_compare for pricing, packaging, positioning, feature, or purchase-threshold comparison.
- website_signal_audit for public website positioning, site structure, content, customer proof, hiring/ecosystem/docs signals.
- deep_research_report for full/deep/comprehensive research report or evidence-chain report.

Competitors and websites:
- competitors contains only names explicitly stated by the user, not entities discovered from search.
- websites contains only public URLs/domains explicitly stated by the user.
- Do not put general search terms into websites.

Confirmation and status:
- Set siteCrawlRequested true when the user asks to crawl, broadly audit, systematically analyze, or comprehensively inspect a website.
- Set siteCrawlRequested false when the latest message changes to ordinary search, quick overview, trend brief, competitor list, or pricing comparison without broad website crawling.
- Set siteCrawlConfirmed true only when the latest message confirms a prior crawl scope. Do not infer confirmation from a new website URL.
- Set deepResearchRequested true when the user asks for deep/full/comprehensive research or a complete report.
- Set deepResearchRequested false when the latest message changes to a quick overview, simple list, light brief, or non-deep follow-up.
- Set deepResearchConfirmed true only when the latest message confirms a prior deep research scope.
- Set status to cancelled only for explicit cancellation or stopping this research.
- Set status to researching when the latest user message gives or changes a research request.
- Leave fields unchanged when the latest message is a follow-up question that does not change scope.
`,
});

effect("resolveResearchReadiness", [
  "status",
  "scenario",
  "subject",
  "websites",
  "siteCrawlRequested",
  "siteCrawlConfirmed",
  "deepResearchRequested",
  "deepResearchConfirmed",
], {
  description: "Reads durable research scope fields and returns status/blocker readiness; it has no connector calls or external side effects.",
  run: (state) => {
    if (state.status === "cancelled" || state.status === "ready") return {};

    const blocker = readinessBlocker(state);
    return {
      blocker,
      status: blocker ? "awaiting_confirmation" as const : "researching" as const,
    };
  },
});

effect("collectPublicEvidence", [
  "status",
  "scenario",
  "subject",
  "purpose",
  "region",
  "language",
  "recency",
  "outputFormat",
  "competitors",
  "websites",
  "siteCrawlRequested",
  "siteCrawlConfirmed",
  "deepResearchRequested",
  "deepResearchConfirmed",
  "researchTask",
], {
  description: "Reads durable research scope, calls read-only web connectors with bounded defaults, returns render-visible evidence and optional research task metadata; it does not persist raw search/page content or write business records.",
  run: async (state, context, _runtime, step) => {
    if (state.status !== "researching" || readinessBlocker(state) !== null) return {};

    const loading = step.start("收集公开资料");
    const collected = await collectEvidence(state, context, step);
    loading.end({ count: collected.messages.length });

    return {
      status: "ready" as const,
      blocker: collected.messages.length === 0 || collected.messages.every((message) => message.isError)
        ? "evidence_unavailable" as const
        : null,
      ...(collected.researchTask ? { researchTask: collected.researchTask } : {}),
      messages: collected.messages,
    };
  },
});

export default render({
  name: "competitor_market_research_reply",
  progress: "正在生成调研回复",
  instruction: `
Write the next professional Chinese reply for a competitor and market research assistant.

Use current research state as authoritative and use tool messages as supporting public evidence. Do not call connectors or mutate state in render.

Reply rules:
1. If the user cancelled, say the current public web research has stopped.
2. If subject and websites are both missing, ask one focused question for the missing research object and explain that it determines search keywords and source selection.
3. If blocker indicates site crawl confirmation is needed, restate the websites, target page types, approximate scope, and exclusions such as login, paid, personal, or restricted pages; ask for explicit confirmation before crawl.
4. If blocker indicates deep research confirmation is needed, restate the research question, region/time/output scope, and explain deep research is slower and still based on public web sources; ask for explicit confirmation before starting.
5. If evidence is unavailable or connector messages are errors, say what public evidence was unavailable and provide an actionable fallback such as narrowing scope, providing known websites, known competitors, region, or industry keywords.
6. If tool evidence is available, start with the research scope used: object, region/language/timeframe/defaults, and source types. Then structure the answer as key findings, evidence/source notes, implications, uncertainty, and next verification steps.
7. For competitor discovery, separate direct competitors, indirect competitors, substitutes, and adjacent players. Do not treat search ranking as proof of direct competition.
8. For competitor profile or website audit, separate website-stated facts, page-structure signals, and assumptions that require verification.
9. For pricing and positioning, do not fill missing prices or packages. Mark unavailable or sales-contact-only prices clearly.
10. For trend briefs, state the timeframe and avoid treating stale sources as current.
11. For deep research, summarize Tavily research output when available, but verify high-risk facts with extracted pages when present.

Always distinguish "公开资料显示", "基于来源的初步判断", and "仍需验证". Important facts should mention source URLs or source types and dates when available in tool messages. Never fabricate market size, revenue, users, funding, pricing, customer lists, product capabilities, or future trends.

Do not claim formal due diligence, legal review, audit, investment rating, supplier security assessment, or compliance review. Do not expose JSON, state names, workflow terms, connector syntax, tool-call markup, or internal labels.
  `,
});

type ResearchTask = z.infer<typeof ResearchTaskSchema>;
type WebSearchOutput = ConnectorOutput<
  OpenWebIntelligenceConnectorCatalog["connectors.web.search"]
>;
type WebMapOutput = ConnectorOutput<
  OpenWebIntelligenceConnectorCatalog["connectors.web.mapSite"]
>;

interface CollectedEvidence {
  messages: ToolMessage[];
  researchTask?: ResearchTask;
}

interface ConnectorCallResult<TId extends WebConnectorId> {
  message: ToolMessage;
  result: ConnectorOutput<OpenWebIntelligenceConnectorCatalog[TId]> | null;
}

interface MappedSiteEvidence {
  website: string;
  mapped: ConnectorCallResult<"connectors.web.mapSite">;
}

/**
 * Collects public-web evidence for the current procedure scope.
 * Input: durable research scope state and connector context.
 * Output: tool messages for render and an optional durable deep-research task id.
 * Boundary: this is read-only evidence collection except Tavily Research task creation, which requires prior user confirmation.
 */
async function collectEvidence(
  state: ResearchState,
  context: WebContext,
  step: WorkflowStepController,
): Promise<CollectedEvidence> {
  const [discoveryMessages, siteMessages, deepResearch] = await Promise.all([
    collectDiscoveryEvidence(state, context, step),
    collectSiteEvidence(state, context, step),
    collectDeepResearchEvidence(state, context, step),
  ]);

  return {
    messages: [
      ...discoveryMessages,
      ...siteMessages,
      ...deepResearch.messages,
    ],
    ...(deepResearch.researchTask ? { researchTask: deepResearch.researchTask } : {}),
  };
}

/**
 * Runs general web and news discovery in parallel, then extracts top search sources.
 * Input: current research scope.
 * Output: render-visible search/news/extraction messages.
 * Boundary: search outputs remain candidate sources until extracted evidence is available.
 */
async function collectDiscoveryEvidence(
  state: ResearchState,
  context: WebContext,
  step: WorkflowStepController,
): Promise<ToolMessage[]> {
  const includeNews = shouldCollectNews(state);
  const discovery = step.start("搜索公开网页和近期新闻", {
    includeNews,
    maxResultsPerSearch: 5,
  });

  const [search, news] = await Promise.all([
    call(context, "connectors.web.search", {
      query: generalQuery(state),
      searchDepth: "advanced",
      maxResults: 5,
      timeRange: state.recency ?? undefined,
      includeAnswer: "basic",
      includeFavicon: true,
    }),
    includeNews
      ? call(context, "connectors.web.searchNews", {
          query: newsQuery(state),
          searchDepth: "advanced",
          maxResults: 5,
          timeRange: state.recency ?? "year",
          includeAnswer: "basic",
          includeFavicon: true,
        })
      : Promise.resolve(null),
  ]);
  discovery.end({
    webSearch: search.result ? "ok" : "failed",
    newsSearch: news ? (news.result ? "ok" : "failed") : "skipped",
  });

  const messages = news ? [search.message, news.message] : [search.message];
  const searchOutput = search.result as WebSearchOutput | null;
  const sourceUrls = searchOutput
    ? searchOutput.results.slice(0, 3).map((result) => result.url)
    : [];

  if (sourceUrls.length === 0) {
    return messages;
  }

  const extraction = step.start("抽取搜索来源正文", {
    urlCount: sourceUrls.length,
  });
  const extracted = await call(context, "connectors.web.extractPages", {
    urls: sourceUrls,
    query: evidenceQuery(state),
    extractDepth: "basic",
    format: "markdown",
    includeFavicon: true,
  });
  extraction.end({
    extracted: extracted.result?.results.length ?? 0,
    failed: extracted.result?.failedResults.length ?? sourceUrls.length,
  });

  return [...messages, extracted.message];
}

/**
 * Maps all user-specified sites in parallel, then extracts mapped pages and crawls confirmed sites.
 * Input: user-provided public websites and crawl confirmation state.
 * Output: render-visible site mapping, page extraction, and bounded crawl messages.
 * Boundary: site crawl is only run after explicit confirmation and keeps raw content out of durable state.
 */
async function collectSiteEvidence(
  state: ResearchState,
  context: WebContext,
  step: WorkflowStepController,
): Promise<ToolMessage[]> {
  const websites = state.websites.slice(0, 3);
  if (websites.length === 0) return [];

  const mapping = step.start("发现站点关键页面", {
    websites: websites.length,
    maxDepth: 2,
    maxBreadth: 20,
    limitPerSite: 20,
  });
  const mappedSites = await Promise.all(
    websites.map(async (website): Promise<MappedSiteEvidence> => ({
      website,
      mapped: await call(context, "connectors.web.mapSite", {
        url: website,
        instructions: siteInstructions(state),
        maxDepth: 2,
        maxBreadth: 20,
        limit: 20,
        allowExternal: false,
      }),
    })),
  );
  mapping.end({
    websites: mappedSites.length,
    succeeded: mappedSites.filter((site) => site.mapped.result !== null).length,
  });

  const [extractMessages, crawlMessages] = await Promise.all([
    collectMappedPageEvidence(state, context, step, mappedSites),
    collectConfirmedCrawlEvidence(state, context, step, websites),
  ]);

  return [
    ...mappedSites.map((site) => site.mapped.message),
    ...extractMessages,
    ...crawlMessages,
  ];
}

/**
 * Extracts high-value URLs discovered by site mapping in parallel batches.
 * Input: mapped site URL lists.
 * Output: render-visible extraction messages.
 * Boundary: only prioritized public pages are extracted to control cost and noise.
 */
async function collectMappedPageEvidence(
  state: ResearchState,
  context: WebContext,
  step: WorkflowStepController,
  mappedSites: MappedSiteEvidence[],
): Promise<ToolMessage[]> {
  const plans = mappedSites
    .map((site) => ({
      website: site.website,
      urls: site.mapped.result
        ? selectMappedUrls((site.mapped.result as WebMapOutput).urls)
        : [],
    }))
    .filter((plan) => plan.urls.length > 0);

  if (plans.length === 0) return [];

  const urlCount = plans.reduce((sum, plan) => sum + plan.urls.length, 0);
  const extraction = step.start("抽取站点高价值页面", {
    websites: plans.length,
    urlCount,
  });
  const extracted = await Promise.all(
    plans.map((plan) =>
      call(context, "connectors.web.extractPages", {
        urls: plan.urls,
        query: siteInstructions(state),
        extractDepth: "basic",
        format: "markdown",
        includeFavicon: true,
      }),
    ),
  );
  extraction.end({
    websites: plans.length,
    urlCount,
    succeeded: extracted.filter((result) => result.result !== null).length,
  });

  return extracted.map((result) => result.message);
}

/**
 * Crawls confirmed website scopes in parallel after the site mapping phase.
 * Input: user-confirmed website scope.
 * Output: render-visible bounded crawl messages.
 * Boundary: crawl is read-only but costlier, so it is gated by durable user confirmation.
 */
async function collectConfirmedCrawlEvidence(
  state: ResearchState,
  context: WebContext,
  step: WorkflowStepController,
  websites: string[],
): Promise<ToolMessage[]> {
  if (!state.siteCrawlRequested || !state.siteCrawlConfirmed) return [];

  const crawling = step.start("抓取已确认站点范围", {
    websites: websites.length,
    maxDepth: 2,
    maxBreadth: 20,
    limitPerSite: 20,
  });
  const crawled = await Promise.all(
    websites.map((website) =>
      call(context, "connectors.web.crawlSite", {
        url: website,
        instructions: siteInstructions(state),
        maxDepth: 2,
        maxBreadth: 20,
        limit: 20,
        allowExternal: false,
        extractDepth: "basic",
        format: "markdown",
        includeFavicon: true,
      }),
    ),
  );
  crawling.end({
    websites: websites.length,
    succeeded: crawled.filter((result) => result.result !== null).length,
  });

  return crawled.map((result) => result.message);
}

/**
 * Starts or polls a deep-research task after explicit user confirmation.
 * Input: current state and connector context.
 * Output: render-visible research messages plus latest durable task metadata when available.
 * Boundary: startResearch is intentionally gated by deepResearchConfirmed.
 */
async function collectDeepResearchEvidence(
  state: ResearchState,
  context: WebContext,
  step: WorkflowStepController,
): Promise<CollectedEvidence> {
  if (!state.deepResearchRequested || !state.deepResearchConfirmed) {
    return { messages: [] };
  }

  if (!state.researchTask) {
    const starting = step.start("启动深度公开资料研究", {
      outputLength: state.outputFormat === "report" ? "long" : "standard",
    });
    const started = await call(context, "connectors.web.startResearch", {
      input: deepResearchInput(state),
      model: "auto",
      citationFormat: "numbered",
      outputLength: state.outputFormat === "report" ? "long" : "standard",
    });
    const task = started.result
      ? ResearchTaskSchema.parse({
          requestId: started.result.requestId,
          createdAt: started.result.createdAt,
          status: started.result.status,
          input: started.result.input,
          model: started.result.model,
        })
      : undefined;
    starting.end({
      status: task?.status ?? "failed",
      requestId: task?.requestId ?? null,
    });

    if (!task) {
      return { messages: [started.message] };
    }

    const polling = step.start("读取深度研究结果", {
      requestId: task.requestId,
    });
    const result = await call(context, "connectors.web.getResearch", {
      requestId: task.requestId,
    });
    polling.end({
      status: result.result?.status ?? "unavailable",
      sources: result.result?.sources.length ?? 0,
    });

    return {
      messages: [started.message, result.message],
      researchTask: task,
    };
  }

  const polling = step.start("读取深度研究结果", {
    requestId: state.researchTask.requestId,
  });
  const result = await call(context, "connectors.web.getResearch", {
    requestId: state.researchTask.requestId,
  });
  polling.end({
    status: result.result?.status ?? "unavailable",
    sources: result.result?.sources.length ?? 0,
  });

  return {
    messages: [result.message],
    researchTask: state.researchTask,
  };
}

/**
 * Calls a connector and wraps success or failure as a ToolMessage.
 * Input: connector id and schema-valid connector input.
 * Output: result for local follow-up logic plus a render-visible tool message.
 * Boundary: failures are converted to evidence-unavailable messages instead of aborting the workflow turn.
 */
async function call<TId extends WebConnectorId>(
  context: WebContext,
  id: TId,
  input: ConnectorInput<OpenWebIntelligenceConnectorCatalog[TId]>,
): Promise<ConnectorCallResult<TId>> {
  try {
    const result = await context.call(id, input, { cache: true });
    return {
      result,
      message: new ToolMessage({ name: id, call: input, result }),
    };
  } catch (error) {
    return {
      result: null,
      message: new ToolMessage({
        name: id,
        call: input,
        result: { error: errorMessage(error) },
        isError: true,
      }),
    };
  }
}

function readinessBlocker(
  state: ResearchState,
): z.infer<typeof BlockerSchema> | null {
  if (state.status === "cancelled") return null;
  if (!state.subject && state.websites.length === 0) return "missing_subject";
  if (state.scenario === "website_signal_audit" && state.websites.length === 0) {
    return "missing_website";
  }
  if (state.siteCrawlRequested && !state.siteCrawlConfirmed) {
    return "needs_site_crawl_confirmation";
  }
  if (state.deepResearchRequested && !state.deepResearchConfirmed) {
    return "needs_deep_research_confirmation";
  }
  return null;
}

function shouldCollectNews(state: ResearchState): boolean {
  return (
    state.scenario === "market_trend_brief" ||
    state.scenario === "competitor_profile" ||
    state.recency !== null
  );
}

function generalQuery(state: ResearchState): string {
  return [
    state.subject,
    scenarioLabel(state.scenario),
    state.purpose,
    state.region,
    state.language,
    state.competitors.length > 0 ? "competitors " + state.competitors.join(" ") : null,
    "market research competitor positioning pricing customers alternatives",
  ]
    .filter(nonEmpty)
    .join(" ");
}

function newsQuery(state: ResearchState): string {
  return [
    state.subject,
    state.competitors.join(" "),
    state.region,
    "recent news product launch funding partnership regulation market trend",
  ]
    .filter(nonEmpty)
    .join(" ");
}

function evidenceQuery(state: ResearchState): string {
  return [
    state.subject,
    state.purpose,
    "features pricing customers positioning market evidence",
  ]
    .filter(nonEmpty)
    .join(" ");
}

function siteInstructions(state: ResearchState): string {
  return [
    "Find public pages useful for competitor and market research.",
    "Prioritize positioning, pricing, features, customers, case studies, docs, blog, press, careers, partners, and product pages.",
    state.purpose ? "Research purpose: " + state.purpose + "." : null,
  ]
    .filter(nonEmpty)
    .join(" ");
}

function deepResearchInput(state: ResearchState): string {
  return [
    "Research question: " + (state.subject ?? state.websites.join(", ")),
    state.purpose ? "Purpose: " + state.purpose : null,
    state.region ? "Region: " + state.region : null,
    state.language ? "Language scope: " + state.language : null,
    state.recency ? "Time scope: " + recencyLabel(state.recency) : null,
    state.competitors.length > 0 ? "User-specified competitors: " + state.competitors.join(", ") : null,
    state.websites.length > 0 ? "User-specified websites: " + state.websites.join(", ") : null,
    "Separate source-supported facts, analysis judgments, and hypotheses that need verification.",
    "Cover competitors, positioning, pricing, customers, recent dynamics, opportunities, risks, and next validation questions where relevant.",
  ]
    .filter(nonEmpty)
    .join("\n");
}

function selectMappedUrls(urls: string[]): string[] {
  const priority = [
    "pricing",
    "plans",
    "features",
    "customers",
    "case",
    "docs",
    "blog",
    "press",
    "about",
    "careers",
    "partners",
  ];
  return urls
    .filter((url) => priority.some((part) => url.toLowerCase().includes(part)))
    .slice(0, 5);
}

function scenarioLabel(
  scenario: z.infer<typeof ResearchScenarioSchema> | null,
): string | null {
  if (!scenario) return null;
  const labels: Record<z.infer<typeof ResearchScenarioSchema>, string> = {
    competitor_landscape: "competitor landscape alternatives",
    competitor_profile: "competitor profile positioning product",
    market_trend_brief: "market trend recent dynamics",
    pricing_positioning_compare: "pricing packaging positioning comparison",
    website_signal_audit: "website positioning content customers signal audit",
    deep_research_report: "deep market research report evidence chain",
  };
  return labels[scenario];
}

function recencyLabel(recency: Recency): string {
  const labels: Record<Recency, string> = {
    day: "today or latest available",
    week: "this week",
    month: "recent month",
    year: "recent year",
  };
  return labels[recency];
}

function nonEmpty(value: string | null | undefined): value is string {
  return Boolean(value && value.trim().length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
