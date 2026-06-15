import {
  ToolMessage,
  defineRouting,
  type ConnectorId,
  type ConnectorInput,
  type WorkflowContext,
  workflow,
  z,
} from "@pac/workflow";
import type { InvestmentAdvisorConnectorCatalog } from "../connectors.js";

const PROCEDURE = "advisor_policy_macro_procedure" as const;

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
  procedure: z.literal(PROCEDURE).nullable(),
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

const metadata = {
  id: PROCEDURE,
  version: "1.0.0",
  description: "投资顾问政策宏观研究，处理政策宏观经济经济指标贸易摩擦影响。",
  routing: defineRouting({
    examples: ["育儿补贴政策对母婴行业的影响","降准对银行股有什么影响","贸易摩擦影响哪些行业"],
    entities: ["政策","宏观","经济指标","贸易摩擦","降准","补贴"],
    neighbors: ["trade_order","portfolio_account","risk_assessment"],
    thresholds: { localAccept: 0.7 },
  }),
};

const initialState = AdvisorStateSchema.parse({
  status: "collecting",
  procedure: PROCEDURE,
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

const invalidation = {
  targetKind: ["blocker"],
  targets: ["blocker"],
  topic: ["blocker"],
  horizon: ["blocker"],
  action: ["blocker"],
  financialPeriod: ["blocker"],
  comparisonFocus: ["blocker"],
  dateRange: ["blocker"],
} satisfies Partial<Record<keyof AdvisorState & string, Array<keyof AdvisorState & string>>>;

const { patch, effect, render } = workflow<AdvisorState, InvestmentAdvisorConnectorCatalog>({
  ...metadata,
  stateSchema: AdvisorStateSchema,
  state: initialState,
});

patch({
  progress: "正在理解政策宏观问题",
  state: {
    status: AdvisorStatusSchema.describe("Only set cancelled when the user explicitly stops this 政策宏观影响 workflow; otherwise set researching when the latest message asks or changes this procedure's research request."),
    targetKind: TargetKindSchema,
    targets: z.array(SecurityTargetSchema),
    topic: z.string(),
    horizon: HorizonSchema,
    action: ActionIntentSchema,
    financialPeriod: z.string(),
    comparisonFocus: z.string(),
    dateRange: DateRangeSchema,
  },
  invalidates: invalidation,
  instruction: `
本 workflow 只处理政策、宏观经济、经济指标、贸易摩擦对行业或公司的影响。
抽取政策或宏观事件到 topic，关注行业/公司到 targets/topic；targetKind 设为 policy_macro。

本 workflow 的抽取边界：
- targets 只包含用户直接说出的股票、ETF、指数、公司、板块代码或名称；不能从名称发明代码。
- 带后缀代码如 300782.SZ 拆为 code=300782、market=SZ、fullCode=300782.SZ。
- 裸数字代码保留 code，除非用户说明市场，否则 market/fullCode 可为空。
- topic 记录用户表达的非股票主题、行业、板块、政策、事件或方法主题。
- horizon 只记录明确时间范围：today、yesterday、tomorrow、short_term、long_term、historical、financial_period。
- action 只记录用户明确交易意图，不能执行交易。
- status 仅在用户明确取消时设为 cancelled；新研究请求设为 researching。
- 不生成最终回复、交易指令、价格目标、工具调用或未表达事实。
`,
});

effect("resolveResearchReadiness", ["status", "targets", "topic"], {
  description: "政策宏观影响 workflow 根据已抽取的研究对象和主题判断是否具备资料收集条件；不调用外部工具。",
  run: (state) => {
    if (state.status === "cancelled" || state.status === "ready") return {};
    const blocker = readinessBlocker(state);
    return {
      blocker,
      status: blocker ? "collecting" : "researching",
    };
  },
});

effect("collectResearchEvidence", [
  "status",
  "targetKind",
  "targets",
  "topic",
  "horizon",
  "action",
  "financialPeriod",
  "comparisonFocus",
  "dateRange",
], {
  description: "政策宏观影响 workflow 调用本 procedure 需要的只读投研工具；工具结果只通过 ToolMessage 暴露给 render，不写长期 state。",
  run: async (state, context, _runtime, step) => {
    if (state.status !== "researching" || readinessBlocker(state) !== null) return {};

    const loading = step.start("收集政策宏观影响资料");
    const messages = await collectEvidence(state, context);
    loading.end({ count: messages.length });

    return {
      status: "ready",
      blocker: messages.length > 0 && messages.every((message) => message.isError) ? "evidence_unavailable" : null,
      messages,
    };
  },
});

export default render({
  name: metadata.id + "_reply",
  progress: "正在生成政策宏观回复",
  instruction: `
本 workflow 的回复目标是解释政策或宏观变量的传导路径。
必须说明可能受益环节、承压环节、影响时滞、落地条件和不确定性。
不能把政策利好直接等同于股价上涨，不能输出补贴转化率、市场规模增量、GDP 影响等精确预测，除非工具事实明确提供且用户要求数据表。
不能输出精确政策发布日期、实施月份、出生人口、补贴金额、行业规模增量、消费转化比例等数字，除非工具事实明确提供同一字段；资料不足时用“政策若落地”“执行节奏仍需跟踪”“人口和消费弹性需以官方数据核验”等不确定表达。
如果用户同时要求产业链或公司清单，要把公司名称表述为研究线索，并明确不是买入清单或投资推荐。
单纯政策或宏观影响问题中，不主动列具体上市公司名称；优先用“奶粉、纸尿裤、母婴零售、医疗护理、上游原料”等行业环节表达，除非用户明确要求公司或股票。

本 workflow 的回复边界：
- 如果资料不足或工具失败，说明当前只能给有限分析，并告诉用户补充什么信息可继续推进。
- 区分“工具资料显示”“可能原因/推断”“仍需核验”，不能补写工具没有返回的精确市场、财务、公告或公司关系数据。
- 不暴露 workflow 字段名、JSON、工具调用语法、内部状态或 connector 机制。
- 结尾自然写明：以上仅为基于公开资料和可用工具结果的研究信息，不构成个性化投资建议或交易指令，市场有风险。
`,
});

/**
 * Collects read-only evidence for the 政策宏观影响 procedure.
 * Input: procedure-local workflow state and connector context.
 * Output: tool facts for this workflow's render phase.
 * Boundary: this function must not execute trades or mutate external systems.
 */
function collectEvidence(state: AdvisorState, context: AdvisorContext): Promise<ToolMessage[]> {
  const topic = evidence.requiredTopic(state);
  return evidence.collectAll([
    evidence.callHotConcepts(context, topic, 8),
    evidence.callNews(context, topic + " 政策 宏观 影响", 10),
    evidence.callReports(context, topic + " 政策 宏观 行业影响", null, null),
  ]);
}

function readinessBlocker(state: AdvisorState): z.infer<typeof BlockerSchema> | null {
  if (false && state.targets.length < 2) return "insufficient_compare_targets";
  if (false && state.targets.length === 0) return "missing_target";
  if (true && !state.topic && state.targets.length === 0) return "missing_topic";
  return null;
}

const evidence = {
  normalizedTargets(state: AdvisorState): NormalizedSecurity[] {
    return state.targets.map(normalizeSecurityTarget);
  },
  firstNormalizedTarget(state: AdvisorState): NormalizedSecurity {
    const [target] = evidence.normalizedTargets(state);
    if (!target) {
      throw new Error("Investment advisor workflow expected at least one target after readiness check.");
    }
    return target;
  },
  requiredTopic(state: AdvisorState): string {
    const topic = state.topic ?? evidence.normalizedTargets(state)[0]?.display;
    if (!topic) {
      throw new Error("Investment advisor workflow expected a topic after readiness check.");
    }
    return topic;
  },
  firstTargetCode(state: AdvisorState): string | null {
    return evidence.normalizedTargets(state)[0]?.code ?? null;
  },
  symbolsFor(targets: NormalizedSecurity[]): string[] | null {
    const symbols = targets.map((target) => target.reportSymbol).filter((symbol): symbol is string => Boolean(symbol));
    return symbols.length > 0 ? symbols : null;
  },
  strategyQuery(state: AdvisorState, display: string): string {
    const action = state.action ? actionLabel(state.action) : "买卖策略";
    const horizon = state.horizon ? horizonLabel(state.horizon) : "";
    return [display, action, horizon, "风险", "控制"].filter((part) => part.length > 0).join(" ");
  },
  marketTargetForState(state: AdvisorState): string {
    const text = [state.topic ?? "", ...state.targets.map((target) => target.raw)].join(" ").toLowerCase();
    if (text.includes("港股") || text.includes("hk")) return "-1";
    if (text.includes("美股") || text.includes("us")) return "74";
    return "0";
  },
  stockMarketEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
    return [
      ...evidence.quoteEvidence(context, target),
      ...evidence.technicalEvidence(context, target),
      ...evidence.capitalFlowEvidence(context, target),
    ];
  },
  quoteEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
    if (!target.fullCode) return [];
    return [evidence.call(context, "connectors.investmentAdvisor.getRealtimeQuotes", { codes: target.fullCode, src: null })];
  },
  technicalEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
    if (!target.fullCode) return [];
    return [evidence.call(context, "connectors.investmentAdvisor.getTechnicalIndicatorSignals", { code: target.fullCode, interval: 60, start_date: null, src: null })];
  },
  capitalFlowEvidence(context: AdvisorContext, target: NormalizedSecurity): Array<Promise<ToolMessage>> {
    if (!target.capitalFlowCode || !target.market) return [];
    return [evidence.call(context, "connectors.investmentAdvisor.getCapitalFlowStats", { period: "day", code: target.capitalFlowCode, setCode: target.market, src: null })];
  },
  historicalEvidence(context: AdvisorContext, target: NormalizedSecurity, state: AdvisorState): Array<Promise<ToolMessage>> {
    if (!target.code || !target.historicalSetCode) return [];
    return [evidence.call(context, "connectors.investmentAdvisor.getHistoricalQuotesByDateRange", {
      code: target.code,
      setCode: target.historicalSetCode,
      startDate: state.dateRange?.start.slice(0, 10) ?? null,
      endDate: state.dateRange?.end.slice(0, 10) ?? null,
      target: "0",
      src: null,
    })];
  },
  companyEvidence(context: AdvisorContext, target: NormalizedSecurity, kinds: Array<"profile" | "mainBusiness" | "industryRank">): Array<Promise<ToolMessage>> {
    if (!target.code || !target.market) return [];
    const input = { code: target.code, market: target.market, limit: 5, secuCode: target.code, secuMarket: target.market, src: null };
    const calls: Array<Promise<ToolMessage>> = [];
    if (kinds.includes("profile")) calls.push(evidence.call(context, "connectors.investmentAdvisor.getCompanyProfile", input));
    if (kinds.includes("mainBusiness")) calls.push(evidence.call(context, "connectors.investmentAdvisor.getMainBusinessComposition", input));
    if (kinds.includes("industryRank")) calls.push(evidence.call(context, "connectors.investmentAdvisor.getCompanyIndustryRankings", input));
    return calls;
  },
  queryEvidence(context: AdvisorContext, state: AdvisorState, query: string): Array<Promise<ToolMessage>> {
    return [
      evidence.callNews(context, query + " 股票 分析", 8),
      evidence.callReports(context, query + " 股票 研究", evidence.symbolsFor(evidence.normalizedTargets(state)), null),
    ];
  },
  callNews(context: AdvisorContext, query: string, count: number): Promise<ToolMessage> {
    return evidence.call(context, "connectors.investmentAdvisor.searchNewsHotTopics", { query, count, src: null });
  },
  callReports(context: AdvisorContext, query: string, symbols: string[] | null, industries: string[] | null): Promise<ToolMessage> {
    return evidence.call(context, "connectors.investmentAdvisor.searchFinancialInvestmentReports", {
      query,
      symbols,
      industries,
      num: 10,
      start_datetime: null,
      end_datetime: null,
      src: null,
    });
  },
  callHotConcepts(context: AdvisorContext, conceptName: string | null, limit: number): Promise<ToolMessage> {
    return evidence.call(context, "connectors.investmentAdvisor.searchHotConcepts", {
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
  },
  callTopMovers(context: AdvisorContext, input: { setDomain: number | null; wantNum: number; target: string | null; sortType: number | null }): Promise<ToolMessage> {
    return evidence.call(context, "connectors.investmentAdvisor.getTopPriceMovers", { ...input, src: null });
  },
  callNorthbound(context: AdvisorContext): Promise<ToolMessage> {
    return evidence.call(context, "connectors.investmentAdvisor.getNorthboundStockList", { date: null, market: null, pageSize: 10, src: null });
  },
  callSouthbound(context: AdvisorContext): Promise<ToolMessage> {
    return evidence.call(context, "connectors.investmentAdvisor.getSouthboundCapitalFlows", { date: null, market: "0", orderBy: "1", orderDirection: "1", page: 1, pageSize: 10, src: null });
  },
  callSectorRelatedEtfs(context: AdvisorContext, code: string | null): Promise<ToolMessage> {
    return evidence.call(context, "connectors.investmentAdvisor.getSectorRelatedEtfs", { code, src: null });
  },
  collectAll(calls: Array<Promise<ToolMessage>>): Promise<ToolMessage[]> {
    return Promise.all(calls);
  },
  async call<TId extends AdvisorConnectorId>(context: AdvisorContext, id: TId, input: ConnectorInput<InvestmentAdvisorConnectorCatalog[TId]>): Promise<ToolMessage> {
    try {
      const result = await context.call(id, input, { cache: true });
      return new ToolMessage({ name: id, call: input, result });
    } catch (error) {
      return new ToolMessage({ name: id, call: input, result: { error: errorMessage(error) }, isError: true });
    }
  },
};

function normalizeSecurityTarget(target: SecurityTarget): NormalizedSecurity {
  const parsedFullCode = parseFullCode(target.fullCode ?? target.raw);
  const code = target.code ?? parsedFullCode?.code ?? bareNumericCode(target.raw);
  const market = target.market ?? parsedFullCode?.market ?? inferAshareMarket(code);
  const fullCode = target.fullCode ?? parsedFullCode?.fullCode ?? (code && market ? code + "." + market : null);
  const display = target.name ?? fullCode ?? code ?? target.raw;

  return {
    display,
    code,
    market,
    fullCode,
    reportSymbol: code && market ? market + ":" + code : null,
    historicalSetCode: market === "SZ" ? "0" : market === "SH" ? "1" : null,
    capitalFlowCode: code && market ? "S" + market + code : null,
  };
}

function parseFullCode(value: string): { code: string; market: z.infer<typeof SecurityMarketSchema>; fullCode: string } | null {
  const match = /^(\d{5,6})\.(SH|SZ|BJ|HK|US)$/i.exec(value.trim());
  if (!match) return null;
  const code = match[1];
  const market = match[2]?.toUpperCase();
  if (!code || !SecurityMarketSchema.safeParse(market).success) return null;
  return { code, market: market as z.infer<typeof SecurityMarketSchema>, fullCode: code + "." + market };
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
