import {
  defineConnectorCatalog,
  defineConnectorRef,
  defineConnectorTool,
  type ConnectorRef,
  z,
} from "@pac/workflow";

const JsonObjectSchema = z.record(z.string(), z.unknown());
const OptionalSourceSchema = JsonObjectSchema.nullable().optional();
const OptionalStringSchema = z.string().nullable().optional();
const OptionalIntegerSchema = z.number().int().nullable().optional();
const OptionalStringOrIntegerSchema = z
  .union([z.string(), z.number().int()])
  .nullable()
  .optional();

export const McpContentSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    uri: z.string().optional(),
  })
  .passthrough();

export const McpToolCallResultSchema = z
  .object({
    content: z.array(McpContentSchema),
    isError: z.boolean().optional(),
  })
  .passthrough();

export type McpToolCallResult = z.infer<typeof McpToolCallResultSchema>;

export const TechnicalIndicatorSignalsInputSchema = z.object({
  code: OptionalStringOrIntegerSchema,
  interval: OptionalStringOrIntegerSchema,
  start_date: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const NewsHotTopicsSearchInputSchema = z.object({
  query: OptionalStringSchema,
  count: OptionalIntegerSchema,
  src: OptionalSourceSchema,
});

export const FinancialInvestmentReportSearchInputSchema = z.object({
  query: OptionalStringSchema,
  symbols: z.array(z.string()).nullable().optional(),
  // industries: z.array(z.string()).nullable().optional(),
  num: OptionalIntegerSchema,
  start_datetime: OptionalStringSchema,
  end_datetime: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const HotConceptSearchInputSchema = z.object({
  concept_id: OptionalStringSchema,
  concept_name: OptionalStringSchema,
  concept_explain: OptionalStringSchema,
  index_code: OptionalStringSchema,
  limit: OptionalIntegerSchema,
  conceptId: OptionalStringSchema,
  conceptName: OptionalStringSchema,
  conceptExplain: OptionalStringSchema,
  indexCode: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const CompanyBySecurityInputSchema = z.object({
  code: OptionalStringSchema,
  market: OptionalStringSchema,
  limit: OptionalIntegerSchema,
  secuCode: OptionalStringSchema,
  secuMarket: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const NorthboundStockListInputSchema = z.object({
  date: OptionalStringSchema,
  market: OptionalStringSchema,
  pageSize: OptionalIntegerSchema,
  src: OptionalSourceSchema,
});

export const SouthboundCapitalFlowsInputSchema = z.object({
  date: OptionalStringSchema,
  market: OptionalStringSchema,
  orderBy: OptionalStringSchema,
  orderDirection: OptionalStringSchema,
  page: OptionalIntegerSchema,
  pageSize: OptionalIntegerSchema,
  src: OptionalSourceSchema,
});

export const RealtimeQuotesInputSchema = z.object({
  codes: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const CapitalFlowStatsInputSchema = z.object({
  period: OptionalStringSchema,
  code: OptionalStringSchema,
  setCode: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const TopPriceMoversInputSchema = z.object({
  setDomain: OptionalIntegerSchema,
  wantNum: OptionalIntegerSchema,
  target: OptionalStringSchema,
  sortType: OptionalIntegerSchema,
  src: OptionalSourceSchema,
});

export const HistoricalQuotesByDateRangeInputSchema = z.object({
  code: OptionalStringSchema,
  setCode: OptionalStringSchema,
  startDate: OptionalStringSchema,
  endDate: OptionalStringSchema,
  target: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const StockRelatedSectorsInputSchema = z.object({
  code: OptionalStringSchema,
  setCode: OptionalStringSchema,
  target: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const EtfBySecurityInputSchema = z.object({
  code: OptionalStringSchema,
  market: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const IndustryChainInputSchema = z.object({
  code: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const SectorRelatedEtfsInputSchema = z.object({
  code: OptionalStringSchema,
  src: OptionalSourceSchema,
});

export const SecurityBasicsInputSchema = z.object({
  page: OptionalIntegerSchema,
  pageSize: OptionalIntegerSchema,
  src: OptionalSourceSchema,
});

export const investmentAdvisorMcpToolNames = {
  getTechnicalIndicatorSignals: "技术指标信号",
  searchNewsHotTopics: "新闻热点资讯搜索",
  searchFinancialInvestmentReports: "金融投资报告搜索",
  searchHotConcepts: "热点概念",
  getCompanyProfile: "公司简况",
  getCompanyEquityHoldings: "公司参股控股",
  getCompanyIndustryRankings: "公司行业地位排名",
  getCompanyExecutives: "公司高管团队",
  getMainBusinessComposition: "主营业务",
  getExDividendEvents: "除权除息",
  getNorthboundStockList: "北向资金个股列表",
  getSouthboundCapitalFlows: "南向资金流向数据",
  getRealtimeQuotes: "当日实时行情",
  getCapitalFlowStats: "资金流向统计数据",
  getTopPriceMovers: "涨幅前N",
  getHistoricalQuotesByDateRange: "日期范围历史行情",
  getStockRelatedSectors: "个股关联板块",
  getEtfRelatedSectors: "查询ETF基金关联的板块信息",
  getEtfTopHoldings: "ETF基金十大重仓股持仓信息",
  getIndustryChainUpstreamDownstream: "产业链上下游相关数据",
  getSectorRelatedEtfs: "查询指定板块相关的ETF基金信息",
  listSecurityBasics: "查询证券标的基本信息",
} as const;

export type InvestmentAdvisorMcpToolName =
  (typeof investmentAdvisorMcpToolNames)[keyof typeof investmentAdvisorMcpToolNames];

export const getTechnicalIndicatorSignalsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getTechnicalIndicatorSignals",
  description:
    "Call the iFinD MCP tool for technical indicator signals by security code and interval.",
  inputSchema: TechnicalIndicatorSignalsInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const searchNewsHotTopicsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.searchNewsHotTopics",
  description: "Call the iFinD MCP tool for hot news and market topic search.",
  inputSchema: NewsHotTopicsSearchInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const searchFinancialInvestmentReportsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.searchFinancialInvestmentReports",
  description:
    "Call the iFinD MCP tool for financial and investment report search.",
  inputSchema: FinancialInvestmentReportSearchInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const searchHotConceptsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.searchHotConcepts",
  description: "Call the iFinD MCP tool for hot concept search.",
  inputSchema: HotConceptSearchInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getCompanyProfileConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getCompanyProfile",
  description: "Call the iFinD MCP tool for company profile information.",
  inputSchema: CompanyBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getCompanyEquityHoldingsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getCompanyEquityHoldings",
  description:
    "Call the iFinD MCP tool for company equity participation and control information.",
  inputSchema: CompanyBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getCompanyIndustryRankingsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getCompanyIndustryRankings",
  description:
    "Call the iFinD MCP tool for company industry ranking information.",
  inputSchema: CompanyBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getCompanyExecutivesConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getCompanyExecutives",
  description:
    "Call the iFinD MCP tool for company executive team information.",
  inputSchema: CompanyBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getMainBusinessCompositionConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getMainBusinessComposition",
  description: "Call the iFinD MCP tool for main business revenue composition.",
  inputSchema: CompanyBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getExDividendEventsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getExDividendEvents",
  description: "Call the iFinD MCP tool for ex-rights and ex-dividend events.",
  inputSchema: CompanyBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getNorthboundStockListConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getNorthboundStockList",
  description: "Call the iFinD MCP tool for northbound active stock lists.",
  inputSchema: NorthboundStockListInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getSouthboundCapitalFlowsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getSouthboundCapitalFlows",
  description: "Call the iFinD MCP tool for southbound capital flow data.",
  inputSchema: SouthboundCapitalFlowsInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getRealtimeQuotesConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getRealtimeQuotes",
  description: "Call the iFinD MCP tool for same-day realtime market quotes.",
  inputSchema: RealtimeQuotesInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getCapitalFlowStatsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getCapitalFlowStats",
  description: "Call the iFinD MCP tool for capital flow statistics.",
  inputSchema: CapitalFlowStatsInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getTopPriceMoversConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getTopPriceMovers",
  description: "Call the iFinD MCP tool for top gainers or decliners.",
  inputSchema: TopPriceMoversInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getHistoricalQuotesByDateRangeConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getHistoricalQuotesByDateRange",
  description:
    "Call the iFinD MCP tool for historical quotes over a date range.",
  inputSchema: HistoricalQuotesByDateRangeInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getStockRelatedSectorsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getStockRelatedSectors",
  description: "Call the iFinD MCP tool for sectors related to one security.",
  inputSchema: StockRelatedSectorsInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getEtfRelatedSectorsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getEtfRelatedSectors",
  description: "Call the iFinD MCP tool for sectors related to one ETF.",
  inputSchema: EtfBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getEtfTopHoldingsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getEtfTopHoldings",
  description: "Call the iFinD MCP tool for an ETF's top ten holdings.",
  inputSchema: EtfBySecurityInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getIndustryChainUpstreamDownstreamConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getIndustryChainUpstreamDownstream",
  description:
    "Call the iFinD MCP tool for upstream and downstream industry chain data.",
  inputSchema: IndustryChainInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const getSectorRelatedEtfsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.getSectorRelatedEtfs",
  description: "Call the iFinD MCP tool for ETFs related to one sector.",
  inputSchema: SectorRelatedEtfsInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const listSecurityBasicsConnector = defineConnectorRef({
  id: "connectors.investmentAdvisor.listSecurityBasics",
  description:
    "Call the iFinD MCP tool for paginated security basic information.",
  inputSchema: SecurityBasicsInputSchema,
  outputSchema: McpToolCallResultSchema,
});

export const investmentAdvisorConnectorCatalog = defineConnectorCatalog({
  "connectors.investmentAdvisor.getTechnicalIndicatorSignals":
    getTechnicalIndicatorSignalsConnector,
  "connectors.investmentAdvisor.searchNewsHotTopics":
    searchNewsHotTopicsConnector,
  "connectors.investmentAdvisor.searchFinancialInvestmentReports":
    searchFinancialInvestmentReportsConnector,
  "connectors.investmentAdvisor.searchHotConcepts": searchHotConceptsConnector,
  "connectors.investmentAdvisor.getCompanyProfile": getCompanyProfileConnector,
  "connectors.investmentAdvisor.getCompanyEquityHoldings":
    getCompanyEquityHoldingsConnector,
  "connectors.investmentAdvisor.getCompanyIndustryRankings":
    getCompanyIndustryRankingsConnector,
  "connectors.investmentAdvisor.getCompanyExecutives":
    getCompanyExecutivesConnector,
  "connectors.investmentAdvisor.getMainBusinessComposition":
    getMainBusinessCompositionConnector,
  "connectors.investmentAdvisor.getExDividendEvents":
    getExDividendEventsConnector,
  "connectors.investmentAdvisor.getNorthboundStockList":
    getNorthboundStockListConnector,
  "connectors.investmentAdvisor.getSouthboundCapitalFlows":
    getSouthboundCapitalFlowsConnector,
  "connectors.investmentAdvisor.getRealtimeQuotes": getRealtimeQuotesConnector,
  "connectors.investmentAdvisor.getCapitalFlowStats":
    getCapitalFlowStatsConnector,
  "connectors.investmentAdvisor.getTopPriceMovers": getTopPriceMoversConnector,
  "connectors.investmentAdvisor.getHistoricalQuotesByDateRange":
    getHistoricalQuotesByDateRangeConnector,
  "connectors.investmentAdvisor.getStockRelatedSectors":
    getStockRelatedSectorsConnector,
  "connectors.investmentAdvisor.getEtfRelatedSectors":
    getEtfRelatedSectorsConnector,
  "connectors.investmentAdvisor.getEtfTopHoldings": getEtfTopHoldingsConnector,
  "connectors.investmentAdvisor.getIndustryChainUpstreamDownstream":
    getIndustryChainUpstreamDownstreamConnector,
  "connectors.investmentAdvisor.getSectorRelatedEtfs":
    getSectorRelatedEtfsConnector,
  "connectors.investmentAdvisor.listSecurityBasics":
    listSecurityBasicsConnector,
});

export type InvestmentAdvisorConnectorCatalog =
  typeof investmentAdvisorConnectorCatalog;

export const investmentAdvisorConnectorTools = [
  defineMcpConnectorTool(
    getTechnicalIndicatorSignalsConnector,
    investmentAdvisorMcpToolNames.getTechnicalIndicatorSignals,
  ),
  defineMcpConnectorTool(
    searchNewsHotTopicsConnector,
    investmentAdvisorMcpToolNames.searchNewsHotTopics,
  ),
  defineMcpConnectorTool(
    searchFinancialInvestmentReportsConnector,
    investmentAdvisorMcpToolNames.searchFinancialInvestmentReports,
  ),
  defineMcpConnectorTool(
    searchHotConceptsConnector,
    investmentAdvisorMcpToolNames.searchHotConcepts,
  ),
  defineMcpConnectorTool(
    getCompanyProfileConnector,
    investmentAdvisorMcpToolNames.getCompanyProfile,
  ),
  defineMcpConnectorTool(
    getCompanyEquityHoldingsConnector,
    investmentAdvisorMcpToolNames.getCompanyEquityHoldings,
  ),
  defineMcpConnectorTool(
    getCompanyIndustryRankingsConnector,
    investmentAdvisorMcpToolNames.getCompanyIndustryRankings,
  ),
  defineMcpConnectorTool(
    getCompanyExecutivesConnector,
    investmentAdvisorMcpToolNames.getCompanyExecutives,
  ),
  defineMcpConnectorTool(
    getMainBusinessCompositionConnector,
    investmentAdvisorMcpToolNames.getMainBusinessComposition,
  ),
  defineMcpConnectorTool(
    getExDividendEventsConnector,
    investmentAdvisorMcpToolNames.getExDividendEvents,
  ),
  defineMcpConnectorTool(
    getNorthboundStockListConnector,
    investmentAdvisorMcpToolNames.getNorthboundStockList,
  ),
  defineMcpConnectorTool(
    getSouthboundCapitalFlowsConnector,
    investmentAdvisorMcpToolNames.getSouthboundCapitalFlows,
  ),
  defineMcpConnectorTool(
    getRealtimeQuotesConnector,
    investmentAdvisorMcpToolNames.getRealtimeQuotes,
  ),
  defineMcpConnectorTool(
    getCapitalFlowStatsConnector,
    investmentAdvisorMcpToolNames.getCapitalFlowStats,
  ),
  defineMcpConnectorTool(
    getTopPriceMoversConnector,
    investmentAdvisorMcpToolNames.getTopPriceMovers,
  ),
  defineMcpConnectorTool(
    getHistoricalQuotesByDateRangeConnector,
    investmentAdvisorMcpToolNames.getHistoricalQuotesByDateRange,
  ),
  defineMcpConnectorTool(
    getStockRelatedSectorsConnector,
    investmentAdvisorMcpToolNames.getStockRelatedSectors,
  ),
  defineMcpConnectorTool(
    getEtfRelatedSectorsConnector,
    investmentAdvisorMcpToolNames.getEtfRelatedSectors,
  ),
  defineMcpConnectorTool(
    getEtfTopHoldingsConnector,
    investmentAdvisorMcpToolNames.getEtfTopHoldings,
  ),
  defineMcpConnectorTool(
    getIndustryChainUpstreamDownstreamConnector,
    investmentAdvisorMcpToolNames.getIndustryChainUpstreamDownstream,
  ),
  defineMcpConnectorTool(
    getSectorRelatedEtfsConnector,
    investmentAdvisorMcpToolNames.getSectorRelatedEtfs,
  ),
  defineMcpConnectorTool(
    listSecurityBasicsConnector,
    investmentAdvisorMcpToolNames.listSecurityBasics,
  ),
];

/**
 * Provides investment-advisor connector tools for engine-owned registry construction.
 * Input: none.
 * Output: MCP-backed connector tools for this agent.
 * Boundary: the engine owns ConnectorRegistry creation and duplicate-id validation across files.
 */
export default function loadInvestmentAdvisorConnectorTools() {
  return investmentAdvisorConnectorTools;
}

const JsonRpcErrorSchema = z
  .object({
    code: z.number().optional(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();

const JsonRpcEnvelopeSchema = z
  .object({
    jsonrpc: z.string().optional(),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    result: z.unknown().optional(),
    error: JsonRpcErrorSchema.optional(),
  })
  .passthrough();

const HeaderMapSchema = z.record(z.string(), z.string());

type McpConfig = {
  url: string;
  headers: Record<string, string>;
};

let nextJsonRpcId = 0;

/**
 * Wraps one Chinese MCP tool as a PAC connector while preserving connector id inference.
 * Input: a connector ref with the MCP argument schema and the original MCP tool name.
 * Output: a connector tool that returns the standard MCP tools/call result payload.
 * Boundary: the MCP result remains generic until a future workflow defines business-specific facts.
 */
function defineMcpConnectorTool<TInput>(
  ref: ConnectorRef<string, TInput, McpToolCallResult>,
  toolName: InvestmentAdvisorMcpToolName,
) {
  return defineConnectorTool(ref, (input) =>
    callInvestmentAdvisorMcpTool(toolName, input),
  );
}

/**
 * Calls one investment advisor MCP tool through Streamable HTTP JSON-RPC.
 * Input: original Chinese MCP tool name and schema-validated arguments.
 * Output: standard MCP tool result with content entries.
 * Boundary: URL and Authorization are read from environment variables so private endpoint data is not committed.
 */
export async function callInvestmentAdvisorMcpTool(
  toolName: InvestmentAdvisorMcpToolName,
  input: unknown,
): Promise<McpToolCallResult> {
  const config = readMcpConfig();
  const initialized = await postMcpRequest(
    config,
    undefined,
    {
      jsonrpc: "2.0",
      id: nextRpcId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "pac-investment-advisor-connectors",
          version: "0.0.0",
        },
      },
    },
    z.unknown(),
  );

  if (!initialized.sessionId) {
    throw new Error(
      "Investment advisor MCP initialize response did not include Mcp-Session-Id.",
    );
  }

  await postMcpNotification(config, initialized.sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });

  const called = await postMcpRequest(
    config,
    initialized.sessionId,
    {
      jsonrpc: "2.0",
      id: nextRpcId(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: input,
      },
    },
    McpToolCallResultSchema,
  );

  return called.result;
}

/**
 * Reads runtime MCP configuration from environment variables.
 * Input: PAC_INVESTMENT_ADVISOR_MCP_URL plus Authorization or JSON headers env vars.
 * Output: request URL and headers for the private MCP endpoint.
 * Boundary: missing URL is a runtime configuration error, not a connector contract error.
 */
function readMcpConfig(): McpConfig {
  const url = process.env.PAC_INVESTMENT_ADVISOR_MCP_URL?.trim();
  if (!url) {
    throw new Error(
      "Missing PAC_INVESTMENT_ADVISOR_MCP_URL for investment advisor MCP connectors.",
    );
  }

  const headers: Record<string, string> = {};
  const authorization =
    process.env.PAC_INVESTMENT_ADVISOR_MCP_AUTHORIZATION?.trim();
  if (authorization) {
    headers.Authorization = authorization;
  }

  const rawHeaders =
    process.env.PAC_INVESTMENT_ADVISOR_MCP_HEADERS_JSON?.trim();
  if (rawHeaders) {
    Object.assign(headers, HeaderMapSchema.parse(JSON.parse(rawHeaders)));
  }

  return { url, headers };
}

/**
 * Sends an MCP JSON-RPC request and parses either JSON or SSE response framing.
 * Input: config, optional session id, JSON-RPC request body, and expected result schema.
 * Output: schema-validated result and any session id returned by the server.
 * Boundary: HTTP status, JSON-RPC error, and result schema failures are surfaced as connector failures.
 */
async function postMcpRequest<T>(
  config: McpConfig,
  sessionId: string | undefined,
  body: unknown,
  resultSchema: z.ZodType<T>,
): Promise<{ result: T; sessionId?: string }> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: buildMcpHeaders(config, sessionId),
    body: JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Investment advisor MCP request failed: HTTP ${response.status} ${response.statusText}.`,
    );
  }

  const envelope = JsonRpcEnvelopeSchema.parse(parseMcpResponse(text));
  if (envelope.error) {
    throw new Error(
      `Investment advisor MCP JSON-RPC error: ${envelope.error.message}`,
    );
  }
  if (!Object.hasOwn(envelope, "result")) {
    throw new Error(
      "Investment advisor MCP JSON-RPC response did not include a result.",
    );
  }

  const result = resultSchema.parse(envelope.result);
  const returnedSessionId = response.headers.get("mcp-session-id");
  return returnedSessionId
    ? { result, sessionId: returnedSessionId }
    : { result };
}

/**
 * Sends an MCP notification after initialize.
 * Input: config, session id, and JSON-RPC notification body.
 * Output: none.
 * Boundary: only transport failure is checked because JSON-RPC notifications have no result.
 */
async function postMcpNotification(
  config: McpConfig,
  sessionId: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: buildMcpHeaders(config, sessionId),
    body: JSON.stringify(body),
  });

  await response.text();
  if (!response.ok) {
    throw new Error(
      `Investment advisor MCP notification failed: HTTP ${response.status} ${response.statusText}.`,
    );
  }
}

/**
 * Builds Streamable HTTP headers for one MCP request.
 * Input: runtime config and optional MCP session id.
 * Output: headers accepted by JSON and SSE MCP responses.
 * Boundary: user-supplied headers can override only endpoint-specific values, not content negotiation.
 */
function buildMcpHeaders(
  config: McpConfig,
  sessionId: string | undefined,
): Record<string, string> {
  return {
    ...config.headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
}

/**
 * Parses an MCP response body regardless of JSON or text/event-stream framing.
 * Input: raw HTTP response body.
 * Output: one JSON-RPC envelope candidate.
 * Boundary: the caller validates JSON-RPC shape and result schema.
 */
function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Investment advisor MCP response body was empty.");
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }

  const data = extractLastSseData(trimmed);
  return JSON.parse(data) as unknown;
}

/**
 * Extracts the final data payload from an SSE response.
 * Input: raw text/event-stream body.
 * Output: final data block joined according to SSE multiline data rules.
 * Boundary: event names are ignored because MCP JSON-RPC payloads live in data lines.
 */
function extractLastSseData(text: string): string {
  const events = text.split(/\r?\n\r?\n/);
  const dataBlocks = events
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n"),
    )
    .filter((data) => data.length > 0);

  const last = dataBlocks.at(-1);
  if (!last) {
    throw new Error(
      "Investment advisor MCP SSE response did not include a data block.",
    );
  }

  return last;
}

function nextRpcId(): number {
  nextJsonRpcId += 1;
  return nextJsonRpcId;
}
