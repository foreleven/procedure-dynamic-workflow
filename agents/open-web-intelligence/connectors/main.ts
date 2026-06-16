import {
  defineConnectorCatalog,
  defineConnectorRef,
  defineConnectorTool,
  z,
} from "@pac/workflow";

const TavilyBaseUrl = "https://api.tavily.com";

const UsageSchema = z.object({
  credits: z.number().nullable(),
});

export const TavilySearchDepthSchema = z.enum([
  "ultra-fast",
  "fast",
  "basic",
  "advanced",
]);
export const TavilySearchTopicSchema = z.enum([
  "general",
  "news",
  "finance",
]);
export const TavilyTimeRangeSchema = z.enum([
  "day",
  "week",
  "month",
  "year",
]);
export const TavilyExtractDepthSchema = z.enum(["basic", "advanced"]);
export const TavilyContentFormatSchema = z.enum(["markdown", "text"]);
export const TavilyAnswerModeSchema = z.enum(["none", "basic", "advanced"]);
export const TavilyResearchModelSchema = z.enum(["mini", "pro", "auto"]);
export const TavilyCitationFormatSchema = z.enum([
  "numbered",
  "mla",
  "apa",
  "chicago",
]);
export const TavilyOutputLengthSchema = z.enum(["short", "standard", "long"]);

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const WebImageSchema = z.object({
  url: z.string().min(1),
  description: z.string().nullable(),
});

export type WebImage = z.infer<typeof WebImageSchema>;

const WebSearchBaseInputSchema = z.object({
  query: z.string().min(1),
  topic: TavilySearchTopicSchema.optional(),
  searchDepth: TavilySearchDepthSchema.optional(),
  chunksPerSource: z.number().int().min(1).max(3).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  timeRange: TavilyTimeRangeSchema.optional(),
  startDate: DateOnlySchema.optional(),
  endDate: DateOnlySchema.optional(),
  includeDomains: z.array(z.string().min(1)).max(50).optional(),
  excludeDomains: z.array(z.string().min(1)).max(50).optional(),
  country: z.string().min(1).optional(),
  includeAnswer: TavilyAnswerModeSchema.optional(),
  includeImages: z.boolean().optional(),
  includeFavicon: z.boolean().optional(),
  exactMatch: z.boolean().optional(),
});

export const WebSearchInputSchema = WebSearchBaseInputSchema
  .superRefine((input, context) => {
    if (
      input.chunksPerSource !== undefined &&
      input.searchDepth !== undefined &&
      input.searchDepth !== "advanced"
    ) {
      context.addIssue({
        code: "custom",
        path: ["chunksPerSource"],
        message: "chunksPerSource requires advanced search depth.",
      });
    }
  });

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export const WebNewsSearchInputSchema = WebSearchBaseInputSchema
  .omit({
    topic: true,
    country: true,
  })
  .superRefine((input, context) => {
    if (
      input.chunksPerSource !== undefined &&
      input.searchDepth !== undefined &&
      input.searchDepth !== "advanced"
    ) {
      context.addIssue({
        code: "custom",
        path: ["chunksPerSource"],
        message: "chunksPerSource requires advanced search depth.",
      });
    }
  });

export type WebNewsSearchInput = z.infer<typeof WebNewsSearchInputSchema>;

export const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number(),
  publishedDate: z.string().nullable(),
  favicon: z.string().nullable(),
  images: z.array(WebImageSchema),
  rawContent: z.string().nullable(),
});

export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const WebSearchOutputSchema = z.object({
  query: z.string(),
  answer: z.string().nullable(),
  results: z.array(WebSearchResultSchema),
  images: z.array(WebImageSchema),
  responseTimeSeconds: z.number().nullable(),
  requestId: z.string().nullable(),
  usage: UsageSchema,
});

export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

export const WebExtractInputSchema = z
  .object({
    urls: z.array(z.string().url()).min(1).max(20),
    query: z.string().min(1).optional(),
    chunksPerSource: z.number().int().min(1).max(5).optional(),
    extractDepth: TavilyExtractDepthSchema.optional(),
    format: TavilyContentFormatSchema.optional(),
    includeImages: z.boolean().optional(),
    includeFavicon: z.boolean().optional(),
    timeoutSeconds: z.number().min(1).max(60).optional(),
  })
  .superRefine((input, context) => {
    if (input.chunksPerSource !== undefined && input.query === undefined) {
      context.addIssue({
        code: "custom",
        path: ["chunksPerSource"],
        message: "chunksPerSource requires query for Tavily Extract reranking.",
      });
    }
  });

export type WebExtractInput = z.infer<typeof WebExtractInputSchema>;

export const WebContentResultSchema = z.object({
  url: z.string(),
  rawContent: z.string(),
  images: z.array(WebImageSchema),
  favicon: z.string().nullable(),
});

export type WebContentResult = z.infer<typeof WebContentResultSchema>;

export const WebExtractFailureSchema = z.object({
  url: z.string(),
  error: z.string(),
});

export type WebExtractFailure = z.infer<typeof WebExtractFailureSchema>;

export const WebExtractOutputSchema = z.object({
  results: z.array(WebContentResultSchema),
  failedResults: z.array(WebExtractFailureSchema),
  responseTimeSeconds: z.number().nullable(),
  requestId: z.string().nullable(),
  usage: UsageSchema,
});

export type WebExtractOutput = z.infer<typeof WebExtractOutputSchema>;

const SiteTraversalBaseInputSchema = z.object({
  url: z.string().min(1),
  instructions: z.string().min(1).optional(),
  maxDepth: z.number().int().min(1).max(5).optional(),
  maxBreadth: z.number().int().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  selectPaths: z.array(z.string().min(1)).max(50).optional(),
  selectDomains: z.array(z.string().min(1)).max(50).optional(),
  excludePaths: z.array(z.string().min(1)).max(50).optional(),
  excludeDomains: z.array(z.string().min(1)).max(50).optional(),
  allowExternal: z.boolean().optional(),
  timeoutSeconds: z.number().min(10).max(150).optional(),
});

export const WebMapSiteInputSchema = SiteTraversalBaseInputSchema;

export type WebMapSiteInput = z.infer<typeof WebMapSiteInputSchema>;

export const WebMapSiteOutputSchema = z.object({
  baseUrl: z.string(),
  urls: z.array(z.string()),
  responseTimeSeconds: z.number().nullable(),
  requestId: z.string().nullable(),
  usage: UsageSchema,
});

export type WebMapSiteOutput = z.infer<typeof WebMapSiteOutputSchema>;

export const WebCrawlSiteInputSchema = SiteTraversalBaseInputSchema.extend({
  chunksPerSource: z.number().int().min(1).max(5).optional(),
  extractDepth: TavilyExtractDepthSchema.optional(),
  format: TavilyContentFormatSchema.optional(),
  includeImages: z.boolean().optional(),
  includeFavicon: z.boolean().optional(),
}).superRefine((input, context) => {
  if (input.chunksPerSource !== undefined && input.instructions === undefined) {
    context.addIssue({
      code: "custom",
      path: ["chunksPerSource"],
      message: "chunksPerSource requires crawl instructions.",
    });
  }
});

export type WebCrawlSiteInput = z.infer<typeof WebCrawlSiteInputSchema>;

export const WebCrawlSiteOutputSchema = z.object({
  baseUrl: z.string(),
  results: z.array(WebContentResultSchema),
  responseTimeSeconds: z.number().nullable(),
  requestId: z.string().nullable(),
  usage: UsageSchema,
});

export type WebCrawlSiteOutput = z.infer<typeof WebCrawlSiteOutputSchema>;

export const WebResearchSourceSchema = z.object({
  title: z.string().nullable(),
  url: z.string(),
  favicon: z.string().nullable(),
});

export type WebResearchSource = z.infer<typeof WebResearchSourceSchema>;

export const WebStartResearchInputSchema = z.object({
  input: z.string().min(1),
  model: TavilyResearchModelSchema.optional(),
  citationFormat: TavilyCitationFormatSchema.optional(),
  includeDomains: z.array(z.string().min(1)).max(20).optional(),
  excludeDomains: z.array(z.string().min(1)).max(20).optional(),
  outputLength: TavilyOutputLengthSchema.optional(),
  outputSchema: JsonObjectSchema.optional(),
});

export type WebStartResearchInput = z.infer<
  typeof WebStartResearchInputSchema
>;

export const WebStartResearchOutputSchema = z.object({
  requestId: z.string(),
  createdAt: z.string(),
  status: z.string(),
  input: z.string(),
  model: z.string(),
  responseTimeSeconds: z.number().nullable(),
});

export type WebStartResearchOutput = z.infer<
  typeof WebStartResearchOutputSchema
>;

export const WebGetResearchInputSchema = z.object({
  requestId: z.string().min(1),
});

export type WebGetResearchInput = z.infer<typeof WebGetResearchInputSchema>;

export const WebResearchContentSchema = z.union([z.string(), JsonObjectSchema]);

export const WebGetResearchOutputSchema = z.object({
  requestId: z.string(),
  createdAt: z.string().nullable(),
  status: z.string(),
  content: WebResearchContentSchema.nullable(),
  sources: z.array(WebResearchSourceSchema),
  responseTimeSeconds: z.number().nullable(),
});

export type WebGetResearchOutput = z.infer<
  typeof WebGetResearchOutputSchema
>;

export const searchWebConnector = defineConnectorRef({
  id: "connectors.web.search",
  description:
    "Read-only Tavily web search for open web source discovery. Search results are candidate sources, not verified facts.",
  inputSchema: WebSearchInputSchema,
  outputSchema: WebSearchOutputSchema,
});

export const searchNewsConnector = defineConnectorRef({
  id: "connectors.web.searchNews",
  description:
    "Read-only Tavily news search for current events and time-sensitive source discovery.",
  inputSchema: WebNewsSearchInputSchema,
  outputSchema: WebSearchOutputSchema,
});

export const extractPagesConnector = defineConnectorRef({
  id: "connectors.web.extractPages",
  description:
    "Read-only Tavily page extraction for selected URLs. Extracted content can be used as cited evidence.",
  inputSchema: WebExtractInputSchema,
  outputSchema: WebExtractOutputSchema,
});

export const mapSiteConnector = defineConnectorRef({
  id: "connectors.web.mapSite",
  description:
    "Read-only Tavily site mapping for discovering relevant URLs within or around one site.",
  inputSchema: WebMapSiteInputSchema,
  outputSchema: WebMapSiteOutputSchema,
});

export const crawlSiteConnector = defineConnectorRef({
  id: "connectors.web.crawlSite",
  description:
    "Read-only Tavily site crawl for collecting extracted content from a bounded website traversal.",
  inputSchema: WebCrawlSiteInputSchema,
  outputSchema: WebCrawlSiteOutputSchema,
});

export const startResearchConnector = defineConnectorRef({
  id: "connectors.web.startResearch",
  description:
    "Start an asynchronous Tavily Research task for multi-source web investigation.",
  inputSchema: WebStartResearchInputSchema,
  outputSchema: WebStartResearchOutputSchema,
});

export const getResearchConnector = defineConnectorRef({
  id: "connectors.web.getResearch",
  description:
    "Read the current status or final report for a Tavily Research task.",
  inputSchema: WebGetResearchInputSchema,
  outputSchema: WebGetResearchOutputSchema,
});

export const openWebIntelligenceConnectorCatalog = defineConnectorCatalog({
  "connectors.web.search": searchWebConnector,
  "connectors.web.searchNews": searchNewsConnector,
  "connectors.web.extractPages": extractPagesConnector,
  "connectors.web.mapSite": mapSiteConnector,
  "connectors.web.crawlSite": crawlSiteConnector,
  "connectors.web.startResearch": startResearchConnector,
  "connectors.web.getResearch": getResearchConnector,
});

export type OpenWebIntelligenceConnectorCatalog =
  typeof openWebIntelligenceConnectorCatalog;

/**
 * Searches the open web through Tavily.
 * Input: query plus bounded source, recency, domain, and response-size controls.
 * Output: ranked candidate sources with snippets and source metadata.
 * Boundary: this is read-only source discovery; workflows should extract selected pages before treating content as evidence.
 */
export async function searchWeb(
  input: WebSearchInput,
): Promise<WebSearchOutput> {
  return callTavilySearch(input);
}

/**
 * Searches Tavily's news topic for current or time-sensitive sources.
 * Input: query plus optional recency, date, and domain controls.
 * Output: ranked news-like candidate sources with snippets and source metadata.
 * Boundary: this is read-only source discovery and does not verify claims by itself.
 */
export async function searchNews(
  input: WebNewsSearchInput,
): Promise<WebSearchOutput> {
  return callTavilySearch({ ...input, topic: "news" });
}

/**
 * Extracts clean content from selected URLs through Tavily.
 * Input: one to twenty URLs plus optional reranking and extraction controls.
 * Output: extracted content and per-URL extraction failures.
 * Boundary: this is read-only evidence collection; inaccessible pages are returned as failures when Tavily reports them.
 */
export async function extractPages(
  input: WebExtractInput,
): Promise<WebExtractOutput> {
  const request = toTavilyExtractRequest(input);
  const response = await postTavily("/extract", request, TavilyExtractRawSchema);
  return WebExtractOutputSchema.parse({
    results: response.results,
    failedResults: response.failed_results.map((failure) => ({
      url: failure.url,
      error: failure.error,
    })),
    responseTimeSeconds: response.response_time ?? null,
    requestId: response.request_id ?? null,
    usage: usageFromRaw(response.usage),
  });
}

/**
 * Maps URLs around one site without extracting full page bodies.
 * Input: root URL plus bounded traversal and regex filters.
 * Output: discovered URLs and request metadata.
 * Boundary: this is read-only discovery; page content still requires extract or crawl.
 */
export async function mapSite(
  input: WebMapSiteInput,
): Promise<WebMapSiteOutput> {
  const response = await postTavily(
    "/map",
    toSiteTraversalRequest(input),
    TavilyMapRawSchema,
  );
  return WebMapSiteOutputSchema.parse({
    baseUrl: response.base_url,
    urls: response.results,
    responseTimeSeconds: response.response_time ?? null,
    requestId: response.request_id ?? null,
    usage: usageFromRaw(response.usage),
  });
}

/**
 * Crawls a site and extracts bounded content from discovered pages.
 * Input: root URL plus traversal, extraction, and regex filters.
 * Output: extracted page bodies and request metadata.
 * Boundary: this is read-only evidence collection and should be kept narrowly scoped to control cost and latency.
 */
export async function crawlSite(
  input: WebCrawlSiteInput,
): Promise<WebCrawlSiteOutput> {
  const response = await postTavily(
    "/crawl",
    toTavilyCrawlRequest(input),
    TavilyCrawlRawSchema,
  );
  return WebCrawlSiteOutputSchema.parse({
    baseUrl: response.base_url,
    results: response.results,
    responseTimeSeconds: response.response_time ?? null,
    requestId: response.request_id ?? null,
    usage: usageFromRaw(response.usage),
  });
}

/**
 * Starts an asynchronous Tavily Research task.
 * Input: research question plus optional model, citation, domain, and output controls.
 * Output: request id and initial task status.
 * Boundary: this enqueues external work; workflows must call getResearch to read completion state.
 */
export async function startResearch(
  input: WebStartResearchInput,
): Promise<WebStartResearchOutput> {
  const response = await postTavily(
    "/research",
    toTavilyResearchRequest(input),
    TavilyStartResearchRawSchema,
  );
  return WebStartResearchOutputSchema.parse({
    requestId: response.request_id,
    createdAt: response.created_at,
    status: response.status,
    input: response.input,
    model: response.model,
    responseTimeSeconds: response.response_time ?? null,
  });
}

/**
 * Reads Tavily Research task status and result.
 * Input: request id returned by startResearch.
 * Output: pending/completed/failed status, report content when available, and cited sources.
 * Boundary: this is read-only polling; workflows own retry or waiting policy.
 */
export async function getResearch(
  input: WebGetResearchInput,
): Promise<WebGetResearchOutput> {
  const response = await getTavily(
    `/research/${encodeURIComponent(input.requestId)}`,
    TavilyGetResearchRawSchema,
  );
  return WebGetResearchOutputSchema.parse({
    requestId: response.request_id,
    createdAt: response.created_at ?? null,
    status: response.status,
    content: response.content ?? null,
    sources: response.sources,
    responseTimeSeconds: response.response_time ?? null,
  });
}

export const openWebIntelligenceConnectorTools = [
  defineConnectorTool(searchWebConnector, searchWeb),
  defineConnectorTool(searchNewsConnector, searchNews),
  defineConnectorTool(extractPagesConnector, extractPages),
  defineConnectorTool(mapSiteConnector, mapSite),
  defineConnectorTool(crawlSiteConnector, crawlSite),
  defineConnectorTool(startResearchConnector, startResearch),
  defineConnectorTool(getResearchConnector, getResearch),
];

/**
 * Provides the open web intelligence connector tools for engine-owned registry construction.
 * Input: none.
 * Output: Tavily-backed read-only web search, extraction, traversal, and research connector tools.
 * Boundary: the engine owns ConnectorRegistry creation and duplicate-id validation across files.
 */
export default function loadOpenWebIntelligenceConnectorTools() {
  return openWebIntelligenceConnectorTools;
}

const TavilyRawImageSchema = z
  .union([
    z.string().min(1),
    z
      .object({
        url: z.string().min(1),
        description: z.string().nullable().optional(),
      })
      .passthrough(),
  ])
  .transform((value) =>
    typeof value === "string"
      ? { url: value, description: null }
      : { url: value.url, description: value.description ?? null },
  );

const TavilyUsageSchema = z
  .object({
    credits: z.number().optional(),
  })
  .passthrough();

const TavilySearchRawResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    content: z.string(),
    score: z.number(),
    raw_content: z.string().nullable().optional(),
    published_date: z.string().nullable().optional(),
    favicon: z.string().nullable().optional(),
    images: z.array(TavilyRawImageSchema).default([]),
  })
  .passthrough();

const TavilySearchRawSchema = z
  .object({
    query: z.string(),
    answer: z.string().nullable().optional(),
    images: z.array(TavilyRawImageSchema).default([]),
    results: z.array(TavilySearchRawResultSchema),
    response_time: z.coerce.number().optional(),
    request_id: z.string().optional(),
    usage: TavilyUsageSchema.optional(),
  })
  .passthrough();

const TavilyContentRawResultSchema = z
  .object({
    url: z.string(),
    raw_content: z.string(),
    images: z.array(TavilyRawImageSchema).default([]),
    favicon: z.string().nullable().optional(),
  })
  .transform((value) => ({
    url: value.url,
    rawContent: value.raw_content,
    images: value.images,
    favicon: value.favicon ?? null,
  }));

const TavilyExtractRawFailureSchema = z
  .object({
    url: z.string(),
    error: z.string(),
  })
  .passthrough();

const TavilyExtractRawSchema = z
  .object({
    results: z.array(TavilyContentRawResultSchema).default([]),
    failed_results: z.array(TavilyExtractRawFailureSchema).default([]),
    response_time: z.coerce.number().optional(),
    request_id: z.string().optional(),
    usage: TavilyUsageSchema.optional(),
  })
  .passthrough();

const TavilyMapRawSchema = z
  .object({
    base_url: z.string(),
    results: z.array(z.string()).default([]),
    response_time: z.coerce.number().optional(),
    request_id: z.string().optional(),
    usage: TavilyUsageSchema.optional(),
  })
  .passthrough();

const TavilyCrawlRawSchema = z
  .object({
    base_url: z.string(),
    results: z.array(TavilyContentRawResultSchema).default([]),
    response_time: z.coerce.number().optional(),
    request_id: z.string().optional(),
    usage: TavilyUsageSchema.optional(),
  })
  .passthrough();

const TavilyStartResearchRawSchema = z
  .object({
    request_id: z.string(),
    created_at: z.string(),
    status: z.string(),
    input: z.string(),
    model: z.string(),
    response_time: z.coerce.number().optional(),
  })
  .passthrough();

const TavilyResearchSourceRawSchema = z
  .object({
    title: z.string().nullable().optional(),
    url: z.string(),
    favicon: z.string().nullable().optional(),
  })
  .transform((value) => ({
    title: value.title ?? null,
    url: value.url,
    favicon: value.favicon ?? null,
  }));

const TavilyGetResearchRawSchema = z
  .object({
    request_id: z.string(),
    created_at: z.string().optional(),
    status: z.string(),
    content: WebResearchContentSchema.optional(),
    sources: z.array(TavilyResearchSourceRawSchema).default([]),
    response_time: z.coerce.number().optional(),
  })
  .passthrough();

const TavilyErrorResponseSchema = z
  .object({
    detail: z
      .union([
        z.string(),
        z.object({ error: z.string().optional() }).passthrough(),
      ])
      .optional(),
  })
  .passthrough();

type TavilyConfig = {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
};

type TavilyPostPath =
  | "/search"
  | "/extract"
  | "/map"
  | "/crawl"
  | "/research";

async function callTavilySearch(
  input: WebSearchInput,
): Promise<WebSearchOutput> {
  const request = toTavilySearchRequest(input);
  const response = await postTavily("/search", request, TavilySearchRawSchema);
  return WebSearchOutputSchema.parse({
    query: response.query,
    answer: response.answer ?? null,
    results: response.results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
      score: result.score,
      publishedDate: result.published_date ?? null,
      favicon: result.favicon ?? null,
      images: result.images,
      rawContent: result.raw_content ?? null,
    })),
    images: response.images,
    responseTimeSeconds: response.response_time ?? null,
    requestId: response.request_id ?? null,
    usage: usageFromRaw(response.usage),
  });
}

function toTavilySearchRequest(input: WebSearchInput): Record<string, unknown> {
  const request: Record<string, unknown> = {
    query: input.query,
    search_depth: input.searchDepth ?? "advanced",
    max_results: input.maxResults ?? 5,
    topic: input.topic ?? "general",
    include_answer: tavilyAnswerMode(input.includeAnswer),
    include_raw_content: false,
    include_images: input.includeImages ?? false,
    include_favicon: input.includeFavicon ?? true,
    include_usage: true,
  };

  setIfDefined(request, "chunks_per_source", input.chunksPerSource);
  setIfDefined(request, "time_range", input.timeRange);
  setIfDefined(request, "start_date", input.startDate);
  setIfDefined(request, "end_date", input.endDate);
  setIfNonEmptyArray(request, "include_domains", input.includeDomains);
  setIfNonEmptyArray(request, "exclude_domains", input.excludeDomains);
  setIfDefined(request, "country", input.country);
  setIfDefined(request, "exact_match", input.exactMatch);

  return request;
}

function toTavilyExtractRequest(input: WebExtractInput): Record<string, unknown> {
  const request: Record<string, unknown> = {
    urls: input.urls,
    extract_depth: input.extractDepth ?? "basic",
    format: input.format ?? "markdown",
    include_images: input.includeImages ?? false,
    include_favicon: input.includeFavicon ?? true,
    include_usage: true,
  };

  setIfDefined(request, "query", input.query);
  setIfDefined(request, "chunks_per_source", input.chunksPerSource);
  setIfDefined(request, "timeout", input.timeoutSeconds);

  return request;
}

function toSiteTraversalRequest(
  input: WebMapSiteInput,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    url: input.url,
    max_depth: input.maxDepth ?? 1,
    max_breadth: input.maxBreadth ?? 20,
    limit: input.limit ?? 50,
    allow_external: input.allowExternal ?? false,
    include_usage: true,
  };

  setIfDefined(request, "instructions", input.instructions);
  setIfNonEmptyArray(request, "select_paths", input.selectPaths);
  setIfNonEmptyArray(request, "select_domains", input.selectDomains);
  setIfNonEmptyArray(request, "exclude_paths", input.excludePaths);
  setIfNonEmptyArray(request, "exclude_domains", input.excludeDomains);
  setIfDefined(request, "timeout", input.timeoutSeconds);

  return request;
}

function toTavilyCrawlRequest(input: WebCrawlSiteInput): Record<string, unknown> {
  const request: Record<string, unknown> = {
    ...toSiteTraversalRequest(input),
    extract_depth: input.extractDepth ?? "basic",
    format: input.format ?? "markdown",
    include_images: input.includeImages ?? false,
    include_favicon: input.includeFavicon ?? true,
  };

  setIfDefined(request, "chunks_per_source", input.chunksPerSource);

  return request;
}

function toTavilyResearchRequest(
  input: WebStartResearchInput,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    input: input.input,
    model: input.model ?? "auto",
    stream: false,
  };

  setIfDefined(request, "citation_format", input.citationFormat);
  setIfNonEmptyArray(request, "include_domains", input.includeDomains);
  setIfNonEmptyArray(request, "exclude_domains", input.excludeDomains);
  setIfDefined(request, "output_length", input.outputLength);
  setIfDefined(request, "output_schema", input.outputSchema);

  return request;
}

/**
 * Posts one schema-validated request to Tavily.
 * Input: API path, JSON body, and schema for the raw Tavily response.
 * Output: schema-validated raw Tavily response.
 * Boundary: HTTP and Tavily error details are surfaced without logging API keys or request bodies.
 */
async function postTavily<T>(
  path: TavilyPostPath,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const config = readTavilyConfig();
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: tavilyHeaders(config),
    body: JSON.stringify(body),
  });
  return parseTavilyResponse(response, path, schema);
}

/**
 * Reads one schema-validated Tavily resource.
 * Input: API path and schema for the raw Tavily response.
 * Output: schema-validated raw Tavily response.
 * Boundary: HTTP and Tavily error details are surfaced without logging API keys.
 */
async function getTavily<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const config = readTavilyConfig();
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "GET",
    headers: tavilyHeaders(config),
  });
  return parseTavilyResponse(response, path, schema);
}

async function parseTavilyResponse<T>(
  response: Response,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Tavily ${path} failed: HTTP ${response.status} ${response.statusText}. ${parseTavilyError(text)}`,
    );
  }

  return schema.parse(parseJsonResponse(text, `Tavily ${path}`));
}

function readTavilyConfig(): TavilyConfig {
  const apiKey = firstConfigured(
    process.env.PAC_TAVILY_API_KEY,
    process.env.TAVILY_API_KEY,
  );
  if (!apiKey) {
    throw new Error(
      "Missing Tavily API key. Set TAVILY_API_KEY or PAC_TAVILY_API_KEY in .env.",
    );
  }

  const projectId = firstConfigured(process.env.TAVILY_PROJECT_ID);
  return {
    baseUrl: stripTrailingSlash(
      firstConfigured(process.env.TAVILY_BASE_URL) ?? TavilyBaseUrl,
    ),
    apiKey,
    ...(projectId ? { projectId } : {}),
  };
}

function tavilyHeaders(config: TavilyConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    ...(config.projectId ? { "X-Project-ID": config.projectId } : {}),
  };
}

function parseJsonResponse(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`${label} response body was empty.`);
  }

  return JSON.parse(trimmed) as unknown;
}

function parseTavilyError(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Empty response body.";

  try {
    const parsed = TavilyErrorResponseSchema.parse(JSON.parse(trimmed));
    if (typeof parsed.detail === "string") return parsed.detail;
    if (parsed.detail?.error) return parsed.detail.error;
  } catch {
    // Fall through to a bounded plain-text snippet.
  }

  return trimmed.slice(0, 300);
}

function tavilyAnswerMode(
  mode: z.infer<typeof TavilyAnswerModeSchema> | undefined,
): boolean | "basic" | "advanced" {
  if (mode === "basic" || mode === "advanced") return mode;
  return false;
}

function usageFromRaw(
  usage: z.infer<typeof TavilyUsageSchema> | undefined,
): z.infer<typeof UsageSchema> {
  return {
    credits: usage?.credits ?? null,
  };
}

function firstConfigured(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }

  return undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function setIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function setIfNonEmptyArray(
  target: Record<string, unknown>,
  key: string,
  value: string[] | undefined,
): void {
  if (value && value.length > 0) {
    target[key] = value;
  }
}
