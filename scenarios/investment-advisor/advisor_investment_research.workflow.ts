import {
  ToolMessage,
  loadWorkflowMetadata,
  type ConnectorId,
  type ConnectorInput,
  type WorkflowContext,
  workflow,
  z,
} from "@pac/workflow";
import type { InvestmentAdvisorConnectorCatalog } from "./connectors.js";

const AdvisorProcedureSchema = z.enum([
  "advisor_stock_brief_procedure",
  "advisor_stock_position_procedure",
  "advisor_stock_trend_procedure",
  "advisor_stock_reason_procedure",
  "advisor_stock_financial_procedure",
  "advisor_stock_compare_procedure",
  "advisor_stock_valuation_procedure",
  "advisor_stock_event_research_procedure",
  "advisor_market_index_procedure",
  "advisor_hot_market_procedure",
  "advisor_sector_intraday_procedure",
  "advisor_sector_outlook_procedure",
  "advisor_policy_macro_procedure",
  "advisor_industry_chain_procedure",
  "advisor_methodology_procedure",
]);

const AdvisorStatusSchema = z.enum(["collecting", "researching", "ready", "cancelled"]);
const TargetKindSchema = z.enum(["stock", "market", "sector", "industry", "policy_macro", "methodology"]);
const SecurityMarketSchema = z.enum(["SH", "SZ", "BJ", "HK", "US"]);
const HorizonSchema = z.enum(["today", "yesterday", "tomorrow", "short_term", "long_term", "historical", "financial_period"]);
const ActionIntentSchema = z.enum(["buy", "sell", "open", "add", "exit", "hold", "take_profit", "stop_loss", "strategy"]);
const BlockerSchema = z.enum(["missing_procedure", "missing_target", "missing_topic", "insufficient_compare_targets", "evidence_unavailable"]);

const SecurityTargetSchema = z.object({
  raw: z.string().describe("User-expressed stock, ETF, index, company, sector code, or name."),
  name: z.string().nullable(),
  code: z.string().nullable(),
  market: SecurityMarketSchema.nullable(),
  fullCode: z.string().nullable().describe("Full code with market suffix when directly expressed, for example 300782.SZ."),
});

const DateRangeSchema = z.object({
  label: z.string(),
  start: z.string(),
  end: z.string(),
});

const AdvisorStateSchema = z.object({
  status: AdvisorStatusSchema,
  procedure: AdvisorProcedureSchema.nullable(),
  targetKind: TargetKindSchema.nullable(),
  targets: z.array(SecurityTargetSchema),
  topic: z.string().nullable(),
  horizon: HorizonSchema.nullable(),
  action: ActionIntentSchema.nullable(),
  financialPeriod: z.string().nullable(),
  comparisonFocus: z.string().nullable(),
  dateRange: DateRangeSchema.nullable(),
  blocker: BlockerSchema.nullable(),
});

export type AdvisorState = z.infer<typeof AdvisorStateSchema>;

type AdvisorProcedure = z.infer<typeof AdvisorProcedureSchema>;
type AdvisorContext = WorkflowContext<InvestmentAdvisorConnectorCatalog>;
type AdvisorConnectorId = ConnectorId<InvestmentAdvisorConnectorCatalog>;
type SecurityTarget = z.infer<typeof SecurityTargetSchema>;
type NormalizedSecurity = {
  display: string;
  code: string | null;
  market: z.infer<typeof SecurityMarketSchema> | null;
  fullCode: string | null;
  reportSymbol: string | null;
  historicalSetCode: string | null;
  capitalFlowCode: string | null;
};

const initialState = AdvisorStateSchema.parse({
  status: "collecting",
  procedure: null,
  targetKind: null,
  targets: [],
  topic: null,
  horizon: null,
  action: null,
  financialPeriod: null,
  comparisonFocus: null,
  dateRange: null,
  blocker: null,
});

const advisorInvalidation = {
  procedure: ["blocker"],
  targetKind: ["blocker"],
  targets: ["blocker"],
  topic: ["blocker"],
  horizon: ["blocker"],
  action: ["blocker"],
  financialPeriod: ["blocker"],
  comparisonFocus: ["blocker"],
  dateRange: ["blocker"],
} satisfies Partial<Record<keyof AdvisorState & string, Array<keyof AdvisorState & string>>>;

const metadata = loadWorkflowMetadata(import.meta.url);

const { patch, derive, render } = workflow<AdvisorState, InvestmentAdvisorConnectorCatalog>({
  ...metadata,
  stateSchema: AdvisorStateSchema,
  state: initialState,
});

patch({
  progress: "正在理解投资研究问题",
  state: {
    status: AdvisorStatusSchema.describe("Set cancelled only for explicit cancellation; otherwise set researching for a new research request."),
    procedure: AdvisorProcedureSchema,
    targetKind: TargetKindSchema,
    targets: z.array(SecurityTargetSchema),
    topic: z.string(),
    horizon: HorizonSchema,
    action: ActionIntentSchema,
    financialPeriod: z.string(),
    comparisonFocus: z.string(),
    dateRange: DateRangeSchema,
  },
  invalidates: advisorInvalidation,
  instruction: `
Extract only investment advisor workflow state from the latest user message.

Procedure mapping:
- advisor_stock_brief_procedure: naked stock name/code or simple "分析一下/怎么样", e.g. 漫步者, 300782, 分析下比亚迪.
- advisor_stock_position_procedure: buy/sell/open/add/exit/hold/take-profit/stop-loss/trading strategy, e.g. 现在可以进吗, 加仓吗.
- advisor_stock_trend_procedure: future trend, short/long term outlook, tomorrow prediction, 后市, 明日预测.
- advisor_stock_reason_procedure:涨跌原因、涨停原因、异动、啥情况、怎么了.
- advisor_stock_financial_procedure: financial condition, earnings, cash flow, profitability, revenue growth, 财报, 业绩.
- advisor_stock_compare_procedure: compare two or more stocks, companies, sectors, or industries.
- advisor_stock_valuation_procedure: investment value, valuation, fair price, intrinsic value.
- advisor_stock_event_research_procedure: penalty, production restart, announcement, news, research report, institutional view, event condition.
- advisor_market_index_procedure: A/HK/US broad market or index analysis, today/yesterday market.
- advisor_hot_market_procedure: hot stocks, hot concepts, hot sectors, attention-worthy directions.
- advisor_sector_intraday_procedure: today's or recent sector/industry board performance.
- advisor_sector_outlook_procedure: industry outlook, market size, development trend, investment logic, competitive landscape.
- advisor_policy_macro_procedure: policy, macro economy, economic indicators, trade friction impact.
- advisor_industry_chain_procedure: upstream/downstream industry chain, related A-share companies, representative companies.
- advisor_methodology_procedure: methodology, playbook, model, template, successful case, policy plan.

Target extraction:
- targets contains only user-expressed stocks, ETFs, indexes, companies, or explicit codes. Do not invent stock codes from names.
- For a code with suffix such as 300782.SZ, set code=300782, market=SZ, fullCode=300782.SZ.
- For a bare numeric code such as 300782, set code=300782 and leave market/fullCode null unless the user stated the market.
- For a stock name such as 比亚迪, set name and raw to that text, leave code/fullCode null.
- For compare questions, put every compared stock/company in targets.
- targetKind should be stock for stock/company questions, market for broad market or index, sector for board/sector questions, industry for industry chain/outlook, policy_macro for macro/policy, methodology for method/template questions.

Other fields:
- topic is the user-expressed non-stock subject, sector, policy, event, industry chain, or methodology topic.
- horizon records only explicit time horizon: today, yesterday, tomorrow, short_term, long_term, historical, or financial_period.
- action records explicit trading action only; never execute it.
- financialPeriod preserves phrases like 2025Q1 or 2024 annual report.
- comparisonFocus records the user-stated comparison dimension, such as 财务状况, 估值, 趋势, or 综合.
- dateRange records explicit date ranges with the user's label and local ISO start/end when available.

Status:
- Set status=cancelled only when the user explicitly stops or cancels the current research flow.
- Set status=researching when the latest message asks a new investment research question or changes procedure/target/topic/horizon/action/focus.

Never produce final replies, trading orders, price targets, connector calls, or invented facts.
`,
});

derive("resolveResearchReadiness", {
  progress: "正在检查研究输入是否完整",
  description: "根据已抽取的研究子场景判断是否缺少股票、对比标的或主题；该步骤不调用外部工具。",
  when: (state) => {
    if (state.status === "cancelled") return false;
    const blocker = readinessBlocker(state);
    return state.blocker !== blocker || (blocker !== null && state.status !== "collecting") || (blocker === null && state.status === "collecting");
  },
  run: (state) => {
    const blocker = readinessBlocker(state);
    return {
      blocker,
      status: blocker ? "collecting" : "researching",
    };
  },
});

derive("collectResearchEvidence", {
  progress: "正在收集投资研究资料",
  description: "基于研究子场景调用只读行情、新闻、研报、公司资料、热点概念和产业链工具；所有工具结果通过 ToolMessage 暴露给 render，不写入长期 state。",
  when: (state, context) =>
    state.status !== "cancelled" &&
    readinessBlocker(state) === null &&
    state.procedure !== null &&
    context.get("collectResearchEvidence:cacheKey") !== researchCacheKey(state),
  run: async (state, context) => {
    if (!state.procedure) return {};

    const cacheKey = researchCacheKey(state);
    const messages = await collectEvidenceForProcedure(state, context);
    context.set("collectResearchEvidence:cacheKey", cacheKey);

    return {
      status: "ready",
      blocker: messages.length > 0 && messages.every((message) => message.isError) ? "evidence_unavailable" : null,
      messages,
    };
  },
});

export default render({
  name: "advisor_investment_research_reply",
  progress: "正在生成投资研究回复",
  instruction: `
Write the next concise Chinese reply for an investment research advisor.

Use current workflow state and the latest runtime tool facts as evidence. Do not expose workflow field names, JSON, MCP payload wrappers, tool-call syntax, or raw internal state.

Reply rules:
1. If status is cancelled, say the current research flow has stopped.
2. If blocker indicates missing_procedure, ask the user what kind of investment research they need.
3. If blocker indicates missing_target, ask for the stock name/code or market/index target needed for the selected procedure.
4. If blocker indicates insufficient_compare_targets, ask for at least two stocks or companies to compare.
5. If blocker indicates missing_topic, ask for the sector, industry, policy, event, or methodology topic.
6. If all tool calls failed, explain that external evidence is temporarily unavailable and ask the user to retry or provide a more specific code/topic.
7. For advisor_stock_position_procedure, provide conditional strategy and risk control. Never give an unconditional buy/sell/add instruction.
8. For advisor_stock_trend_procedure, provide scenario analysis. Never guarantee tomorrow or future price movement.
9. For advisor_stock_reason_procedure, separate supported facts, plausible drivers, and items requiring announcement/news verification.
10. For every procedure, satisfy its primary business objective before listing related companies or concepts. Do not turn an outlook, policy, valuation, or market question into only a company list.
11. If a stock name has no code and structured quote/company tools are absent, state that the answer relies on news/report-style evidence and that a full code would improve precision.
12. Never invent precise market data. Prefer qualitative wording such as "偏强", "分化", "资金活跃", "资料未返回精确数值".
13. For advisor_market_index_procedure, when state.targets has no concrete code/fullCode, exact index点位、涨跌幅、成交额、日期收盘价 are forbidden even if market news snippets contain numbers. Say that no specific index code was provided, so the answer uses qualitative market clues.
14. For advisor_sector_intraday_procedure and advisor_hot_market_procedure, exact individual stock prices、涨跌幅、成交额、涨停数量 and similar intraday numbers are forbidden unless the user gave a concrete code and structured quote/top-movers facts are present. Otherwise describe strength, drivers, rotation, and risks qualitatively.
15. For advisor_policy_macro_procedure, do not output precise quantitative forecasts such as subsidy conversion percentages, market-size increments, GDP/retail-sales impacts, or birth-population figures unless the user asked for a data table and the exact values are visible in official-style tool facts. Focus on transmission path, beneficiary/pressured links, time lag, and uncertainty.
16. For advisor_sector_outlook_procedure, use this order: industry outlook, demand drivers, supply/technology constraints, competitive landscape, investment logic, key risks. Representative companies may appear only after those sections and must not dominate the answer.
17. For advisor_hot_market_procedure, explicitly discuss sustainability risk or fade-out risk for hot concepts.
18. For advisor_industry_chain_procedure and any reply listing A-share companies, state that the names are research leads from available sources, require further verification, and are not a buy list.
19. End every reply with this boundary in natural Chinese: "以上仅为基于公开资料和可用工具结果的研究信息，不构成个性化投资建议或交易指令，市场有风险。"

Return natural Chinese. Keep it dense but readable.
`,
});

async function collectEvidenceForProcedure(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  switch (state.procedure) {
    case "advisor_stock_brief_procedure":
      return collectStockBriefEvidence(state, context);
    case "advisor_stock_position_procedure":
      return collectStockPositionEvidence(state, context);
    case "advisor_stock_trend_procedure":
      return collectStockTrendEvidence(state, context);
    case "advisor_stock_reason_procedure":
      return collectStockReasonEvidence(state, context);
    case "advisor_stock_financial_procedure":
      return collectStockFinancialEvidence(state, context);
    case "advisor_stock_compare_procedure":
      return collectStockCompareEvidence(state, context);
    case "advisor_stock_valuation_procedure":
      return collectStockValuationEvidence(state, context);
    case "advisor_stock_event_research_procedure":
      return collectStockEventEvidence(state, context);
    case "advisor_market_index_procedure":
      return collectMarketIndexEvidence(state, context);
    case "advisor_hot_market_procedure":
      return collectHotMarketEvidence(state, context);
    case "advisor_sector_intraday_procedure":
      return collectSectorIntradayEvidence(state, context);
    case "advisor_sector_outlook_procedure":
      return collectSectorOutlookEvidence(state, context);
    case "advisor_policy_macro_procedure":
      return collectPolicyMacroEvidence(state, context);
    case "advisor_industry_chain_procedure":
      return collectIndustryChainEvidence(state, context);
    case "advisor_methodology_procedure":
      return collectMethodologyEvidence(state, context);
    case null:
      return [];
  }
}

function collectStockBriefEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = firstNormalizedTarget(state);
  return collectAll([
    ...stockMarketEvidence(context, target),
    ...companyEvidence(context, target, ["profile"]),
    ...queryEvidence(context, state, target.display),
  ]);
}

function collectStockPositionEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = firstNormalizedTarget(state);
  return collectAll([
    ...stockMarketEvidence(context, target),
    callNews(context, strategyQuery(state, target.display), 8),
    callReports(context, strategyQuery(state, target.display), symbolsFor([target]), null),
  ]);
}

function collectStockTrendEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = firstNormalizedTarget(state);
  return collectAll([
    ...stockMarketEvidence(context, target),
    ...historicalEvidence(context, target, state),
    callNews(context, `${target.display} 后市 趋势`, 8),
    callReports(context, `${target.display} 趋势 展望`, symbolsFor([target]), null),
  ]);
}

function collectStockReasonEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = firstNormalizedTarget(state);
  return collectAll([
    ...stockMarketEvidence(context, target),
    callTopMovers(context, { setDomain: null, wantNum: 20, target: "0", sortType: null }),
    callNews(context, `${target.display} 涨跌 异动 原因`, 10),
    callReports(context, `${target.display} 异动 原因`, symbolsFor([target]), null),
  ]);
}

function collectStockFinancialEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = firstNormalizedTarget(state);
  return collectAll([
    ...companyEvidence(context, target, ["profile", "mainBusiness", "industryRank"]),
    callReports(context, `${target.display} ${state.financialPeriod ?? ""} 财务 业绩 现金流`, symbolsFor([target]), null),
    callNews(context, `${target.display} ${state.financialPeriod ?? ""} 财报 业绩`, 8),
  ]);
}

function collectStockCompareEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const targets = normalizedTargets(state);
  const calls = targets.flatMap((target) => [
    ...companyEvidence(context, target, ["profile", "mainBusiness", "industryRank"]),
    ...quoteEvidence(context, target),
  ]);
  return collectAll([
    ...calls,
    callReports(context, `${targets.map((target) => target.display).join(" ")} ${state.comparisonFocus ?? "对比"}`, symbolsFor(targets), null),
  ]);
}

function collectStockValuationEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = firstNormalizedTarget(state);
  return collectAll([
    ...companyEvidence(context, target, ["profile", "mainBusiness", "industryRank"]),
    ...quoteEvidence(context, target),
    ...historicalEvidence(context, target, state),
    callReports(context, `${target.display} 投资价值 估值`, symbolsFor([target]), null),
  ]);
}

function collectStockEventEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = firstNormalizedTarget(state);
  const query = `${target.display} ${state.topic ?? ""} 公告 新闻 研报 机构观点`;
  return collectAll([
    ...companyEvidence(context, target, ["profile"]),
    callNews(context, query, 10),
    callReports(context, query, symbolsFor([target]), null),
  ]);
}

function collectMarketIndexEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const target = normalizedTargets(state)[0];
  return collectAll([
    ...(target ? quoteEvidence(context, target) : []),
    callTopMovers(context, { setDomain: null, wantNum: 20, target: marketTargetForState(state), sortType: null }),
    callNorthbound(context),
    callSouthbound(context),
    callNews(context, state.topic ?? "今日 大盘 指数 行情", 10),
    callReports(context, state.topic ?? "大盘 指数 市场 分析", null, null),
  ]);
}

function collectHotMarketEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  return collectAll([
    callHotConcepts(context, state.topic ?? null, 10),
    callTopMovers(context, { setDomain: null, wantNum: 30, target: marketTargetForState(state), sortType: 1 }),
    callNorthbound(context),
    callSouthbound(context),
    callNews(context, state.topic ?? "今日 热门 个股 热点 概念", 10),
  ]);
}

function collectSectorIntradayEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const topic = requiredTopic(state);
  return collectAll([
    callHotConcepts(context, topic, 10),
    callSectorRelatedEtfs(context, firstTargetCode(state)),
    callNews(context, `${topic} 板块 今日 行情`, 10),
    callReports(context, `${topic} 板块 行情 资金流`, null, [topic]),
  ]);
}

function collectSectorOutlookEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const topic = requiredTopic(state);
  return collectAll([
    callHotConcepts(context, topic, 10),
    callSectorRelatedEtfs(context, firstTargetCode(state)),
    callNews(context, `${topic} 行业 前景 发展趋势`, 10),
    callReports(context, `${topic} 行业 前景 市场规模 竞争格局 投资逻辑`, null, [topic]),
  ]);
}

function collectPolicyMacroEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const topic = requiredTopic(state);
  return collectAll([
    callHotConcepts(context, topic, 8),
    callNews(context, `${topic} 政策 宏观 影响`, 10),
    callReports(context, `${topic} 政策 宏观 行业影响`, null, null),
  ]);
}

function collectIndustryChainEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const topic = requiredTopic(state);
  const code = firstTargetCode(state);
  return collectAll([
    ...(code ? [callEvidence(context, "connectors.investmentAdvisor.getIndustryChainUpstreamDownstream", { code, src: null })] : []),
    callHotConcepts(context, topic, 10),
    callSectorRelatedEtfs(context, code),
    callReports(context, `${topic} 产业链 上下游 A股 公司`, null, [topic]),
    callNews(context, `${topic} 产业链 相关公司`, 10),
  ]);
}

function collectMethodologyEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const topic = requiredTopic(state);
  return collectAll([
    callReports(context, `${topic} 方法论 范本 模型 指标`, null, null),
    callNews(context, `${topic} 方法 指标 数据 解读`, 8),
  ]);
}

function stockMarketEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
  return [
    ...quoteEvidence(context, target),
    ...technicalEvidence(context, target),
    ...capitalFlowEvidence(context, target),
  ];
}

function quoteEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
  if (!target.fullCode) return [];
  return [
    callEvidence(context, "connectors.investmentAdvisor.getRealtimeQuotes", {
      codes: target.fullCode,
      src: null,
    }),
  ];
}

function technicalEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
  if (!target.fullCode) return [];
  return [
    callEvidence(context, "connectors.investmentAdvisor.getTechnicalIndicatorSignals", {
      code: target.fullCode,
      interval: 60,
      start_date: null,
      src: null,
    }),
  ];
}

function capitalFlowEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
  if (!target.capitalFlowCode || !target.market) return [];
  return [
    callEvidence(context, "connectors.investmentAdvisor.getCapitalFlowStats", {
      period: "day",
      code: target.capitalFlowCode,
      setCode: target.market,
      src: null,
    }),
  ];
}

function historicalEvidence(
  context: AdvisorContext,
  target: NormalizedSecurity,
  state: AdvisorState,
): Array<Promise<ToolMessage>> {
  if (!target.code || !target.historicalSetCode) return [];
  return [
    callEvidence(context, "connectors.investmentAdvisor.getHistoricalQuotesByDateRange", {
      code: target.code,
      setCode: target.historicalSetCode,
      startDate: state.dateRange?.start.slice(0, 10) ?? null,
      endDate: state.dateRange?.end.slice(0, 10) ?? null,
      target: "0",
      src: null,
    }),
  ];
}

function companyEvidence(
  context: AdvisorContext,
  target: NormalizedSecurity,
  kinds: Array<"profile" | "mainBusiness" | "industryRank">,
): Array<Promise<ToolMessage>> {
  if (!target.code || !target.market) return [];
  const input = {
    code: target.code,
    market: target.market,
    limit: 5,
    secuCode: target.code,
    secuMarket: target.market,
    src: null,
  };
  const calls: Array<Promise<ToolMessage>> = [];
  if (kinds.includes("profile")) {
    calls.push(callEvidence(context, "connectors.investmentAdvisor.getCompanyProfile", input));
  }
  if (kinds.includes("mainBusiness")) {
    calls.push(callEvidence(context, "connectors.investmentAdvisor.getMainBusinessComposition", input));
  }
  if (kinds.includes("industryRank")) {
    calls.push(callEvidence(context, "connectors.investmentAdvisor.getCompanyIndustryRankings", input));
  }
  return calls;
}

function queryEvidence(context: AdvisorContext, state: AdvisorState, query: string): Array<Promise<ToolMessage>> {
  const targets = normalizedTargets(state);
  return [
    callNews(context, `${query} 股票 分析`, 8),
    callReports(context, `${query} 股票 研究`, symbolsFor(targets), null),
  ];
}

function callNews(context: AdvisorContext, query: string, count: number): Promise<ToolMessage> {
  return callEvidence(context, "connectors.investmentAdvisor.searchNewsHotTopics", {
    query,
    count,
    src: null,
  });
}

function callReports(
  context: AdvisorContext,
  query: string,
  symbols: string[] | null,
  industries: string[] | null,
): Promise<ToolMessage> {
  return callEvidence(context, "connectors.investmentAdvisor.searchFinancialInvestmentReports", {
    query,
    symbols,
    industries,
    num: 10,
    start_datetime: null,
    end_datetime: null,
    src: null,
  });
}

function callHotConcepts(context: AdvisorContext, conceptName: string | null, limit: number): Promise<ToolMessage> {
  return callEvidence(context, "connectors.investmentAdvisor.searchHotConcepts", {
    concept_id: null,
    concept_name: conceptName,
    concept_explain: null,
    index_code: null,
    limit,
    conceptId: null,
    conceptName,
    conceptExplain: null,
    indexCode: null,
    src: null,
  });
}

function callTopMovers(
  context: AdvisorContext,
  input: {
    setDomain: number | null;
    wantNum: number;
    target: string | null;
    sortType: number | null;
  },
): Promise<ToolMessage> {
  return callEvidence(context, "connectors.investmentAdvisor.getTopPriceMovers", {
    setDomain: input.setDomain,
    wantNum: input.wantNum,
    target: input.target,
    sortType: input.sortType,
    src: null,
  });
}

function callNorthbound(context: AdvisorContext): Promise<ToolMessage> {
  return callEvidence(context, "connectors.investmentAdvisor.getNorthboundStockList", {
    date: null,
    market: null,
    pageSize: 10,
    src: null,
  });
}

function callSouthbound(context: AdvisorContext): Promise<ToolMessage> {
  return callEvidence(context, "connectors.investmentAdvisor.getSouthboundCapitalFlows", {
    date: null,
    market: "0",
    orderBy: "1",
    orderDirection: "1",
    page: 1,
    pageSize: 10,
    src: null,
  });
}

function callSectorRelatedEtfs(context: AdvisorContext, code: string | null): Promise<ToolMessage> {
  return callEvidence(context, "connectors.investmentAdvisor.getSectorRelatedEtfs", {
    code,
    src: null,
  });
}

async function collectAll(calls: Array<Promise<ToolMessage>>): Promise<ToolMessage[]> {
  return Promise.all(calls);
}

/**
 * Calls one evidence connector and converts connector failures into tool facts.
 * Input: typed connector id and schema-valid input.
 * Output: ToolMessage with result or an isError marker.
 * Boundary: investment research should degrade on one unavailable data source instead of losing all evidence.
 */
async function callEvidence<TId extends AdvisorConnectorId>(
  context: AdvisorContext,
  id: TId,
  input: ConnectorInput<InvestmentAdvisorConnectorCatalog[TId]>,
): Promise<ToolMessage> {
  try {
    const result = await context.call(id, input);
    return new ToolMessage({ name: id, call: input, result });
  } catch (error) {
    return new ToolMessage({
      name: id,
      call: input,
      result: { error: errorMessage(error) },
      isError: true,
    });
  }
}

function readinessBlocker(state: AdvisorState): z.infer<typeof BlockerSchema> | null {
  if (!state.procedure) return "missing_procedure";
  if (stockProcedures.has(state.procedure) && state.targets.length === 0) return "missing_target";
  if (state.procedure === "advisor_stock_compare_procedure" && state.targets.length < 2) {
    return "insufficient_compare_targets";
  }
  if (topicProcedures.has(state.procedure) && !state.topic && state.targets.length === 0) return "missing_topic";
  return null;
}

function researchCacheKey(state: AdvisorState): string {
  return JSON.stringify({
    procedure: state.procedure,
    targetKind: state.targetKind,
    targets: state.targets,
    topic: state.topic,
    horizon: state.horizon,
    action: state.action,
    financialPeriod: state.financialPeriod,
    comparisonFocus: state.comparisonFocus,
    dateRange: state.dateRange,
  });
}

function normalizedTargets(state: AdvisorState): NormalizedSecurity[] {
  return state.targets.map(normalizeSecurityTarget);
}

function firstNormalizedTarget(state: AdvisorState): NormalizedSecurity {
  const [target] = normalizedTargets(state);
  if (!target) {
    throw new Error("Investment advisor workflow expected at least one target after readiness check.");
  }
  return target;
}

function normalizeSecurityTarget(target: SecurityTarget): NormalizedSecurity {
  const parsedFullCode = parseFullCode(target.fullCode ?? target.raw);
  const code = target.code ?? parsedFullCode?.code ?? bareNumericCode(target.raw);
  const market = target.market ?? parsedFullCode?.market ?? inferAshareMarket(code);
  const fullCode = target.fullCode ?? parsedFullCode?.fullCode ?? (code && market ? `${code}.${market}` : null);
  const display = target.name ?? fullCode ?? code ?? target.raw;

  return {
    display,
    code,
    market,
    fullCode,
    reportSymbol: code && market ? `${market}:${code}` : null,
    historicalSetCode: market === "SZ" ? "0" : market === "SH" ? "1" : null,
    capitalFlowCode: code && market ? `S${market}${code}` : null,
  };
}

function parseFullCode(value: string): { code: string; market: z.infer<typeof SecurityMarketSchema>; fullCode: string } | null {
  const match = /^(\d{5,6})\.(SH|SZ|BJ|HK|US)$/i.exec(value.trim());
  if (!match) return null;
  const code = match[1];
  const market = match[2]?.toUpperCase();
  if (!code || !SecurityMarketSchema.safeParse(market).success) return null;
  return { code, market: market as z.infer<typeof SecurityMarketSchema>, fullCode: `${code}.${market}` };
}

function bareNumericCode(value: string): string | null {
  const normalized = value.trim();
  return /^\d{5,6}$/.test(normalized) ? normalized : null;
}

function inferAshareMarket(code: string | null): z.infer<typeof SecurityMarketSchema> | null {
  if (!code) return null;
  if (/^(60|68|51|56|58)/.test(code)) return "SH";
  if (/^(00|30|15|16|18)/.test(code)) return "SZ";
  if (/^(43|83|87|88|92)/.test(code)) return "BJ";
  return null;
}

function symbolsFor(targets: NormalizedSecurity[]): string[] | null {
  const symbols = targets.map((target) => target.reportSymbol).filter((symbol): symbol is string => Boolean(symbol));
  return symbols.length > 0 ? symbols : null;
}

function strategyQuery(state: AdvisorState, display: string): string {
  const action = state.action ? actionLabel(state.action) : "买卖策略";
  const horizon = state.horizon ? horizonLabel(state.horizon) : "";
  return `${display} ${action} ${horizon} 风险 控制`;
}

function requiredTopic(state: AdvisorState): string {
  const topic = state.topic ?? normalizedTargets(state)[0]?.display;
  if (!topic) {
    throw new Error("Investment advisor workflow expected a topic after readiness check.");
  }
  return topic;
}

function firstTargetCode(state: AdvisorState): string | null {
  return normalizedTargets(state)[0]?.code ?? null;
}

function marketTargetForState(state: AdvisorState): string {
  const text = `${state.topic ?? ""} ${state.targets.map((target) => target.raw).join(" ")}`.toLowerCase();
  if (text.includes("港股") || text.includes("hk")) return "-1";
  if (text.includes("美股") || text.includes("us")) return "74";
  return "0";
}

function actionLabel(action: z.infer<typeof ActionIntentSchema>): string {
  const labels: Record<z.infer<typeof ActionIntentSchema>, string> = {
    buy: "买入",
    sell: "卖出",
    open: "建仓",
    add: "加仓",
    exit: "离场",
    hold: "持有",
    take_profit: "止盈",
    stop_loss: "止损",
    strategy: "买卖策略",
  };
  return labels[action];
}

function horizonLabel(horizon: z.infer<typeof HorizonSchema>): string {
  const labels: Record<z.infer<typeof HorizonSchema>, string> = {
    today: "今日",
    yesterday: "昨日",
    tomorrow: "明日",
    short_term: "短期",
    long_term: "长期",
    historical: "历史",
    financial_period: "财报期",
  };
  return labels[horizon];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const stockProcedures = new Set<AdvisorProcedure>([
  "advisor_stock_brief_procedure",
  "advisor_stock_position_procedure",
  "advisor_stock_trend_procedure",
  "advisor_stock_reason_procedure",
  "advisor_stock_financial_procedure",
  "advisor_stock_compare_procedure",
  "advisor_stock_valuation_procedure",
  "advisor_stock_event_research_procedure",
]);

const topicProcedures = new Set<AdvisorProcedure>([
  "advisor_sector_intraday_procedure",
  "advisor_sector_outlook_procedure",
  "advisor_policy_macro_procedure",
  "advisor_industry_chain_procedure",
  "advisor_methodology_procedure",
]);
