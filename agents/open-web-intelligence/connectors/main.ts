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

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

export const searchWebConnector = defineConnectorRef({
  id: "connectors.web.search",
  description:
    "Read-only Tavily web search for open web source discovery. Search results are candidate sources, not verified facts.",
  inputSchema: WebSearchInputSchema,
  outputSchema: WebSearchOutputSchema,
});

export const extractPagesConnector = defineConnectorRef({
  id: "connectors.web.extractPages",
  description:
    "Read-only Tavily page extraction for selected URLs. Extracted content can be used as cited evidence.",
  inputSchema: WebExtractInputSchema,
  outputSchema: WebExtractOutputSchema,
});

export const openWebIntelligenceConnectorCatalog = defineConnectorCatalog({
  "connectors.web.search": searchWebConnector,
  "connectors.web.extractPages": extractPagesConnector,
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

export const openWebIntelligenceConnectorTools = [
  defineConnectorTool(searchWebConnector, searchWeb),
  defineConnectorTool(extractPagesConnector, extractPages),
];

/**
 * Provides the open web intelligence connector tools for engine-owned registry construction.
 * Input: none.
 * Output: Tavily-backed read-only web search and page extraction connector tools.
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

type TavilyPostPath = "/search" | "/extract";

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
