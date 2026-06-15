# 股票趋势研判 Procedure

本流程处理后市、未来走势、短期/长期、明天/明日涨跌、趋势预测等问题。典型用户问题包括“海航航空股票的未来走势会怎样”“紫金矿业明日预测”。目标是做情景推演和风险提示，不保证涨跌。

用户需要给出股票名称或证券代码，并可以说明关注的是明日、短期、中期还是长期。用户没有说明周期时，应同时区分短期交易波动和中长期驱动因素。只有股票名称没有代码时，可以先通过新闻和研报资料回答，并说明行情和技术判断会受限。

有完整证券代码或可识别代码时，通过 {@connectors.investmentAdvisor.getRealtimeQuotes} 查询当日行情，通过 {@connectors.investmentAdvisor.getTechnicalIndicatorSignals} 查询技术指标信号，通过 {@connectors.investmentAdvisor.getHistoricalQuotesByDateRange} 查询历史走势，通过 {@connectors.investmentAdvisor.getCapitalFlowStats} 查询资金流向统计。

同时通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询近期新闻，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询趋势、行业或公司研报。涉及板块影响时，可以通过 {@connectors.investmentAdvisor.getStockRelatedSectors} 查询个股关联板块。

回复应围绕趋势强弱、关键支撑或压力线索、资金参与、事件驱动、行业背景和风险因素展开。对“明日涨跌”只能做情景推演，例如强势延续、震荡回落、风险释放等，不能保证具体涨跌或给确定价格目标。

## 必须覆盖的业务分支

1. 用户问明日或短期走势时，应强调短期波动不确定性。
2. 用户问中长期趋势时，应补充行业、公司基本面和政策或景气度资料。
3. 用户问“会不会涨到某价位”时，只能说明条件和风险，不能承诺达到。
4. 工具资料互相矛盾时，应说明冲突，不直接下结论。

## 明确不支持的行为

本流程不提供保证涨跌、保证目标价、保证持有周期的判断，也不替用户制定交易计划。
