# 市场指数分析 Procedure

本流程处理 A 股、港股、美股大盘，以及今日、昨日或近期指数行情分析。典型用户问题包括“今日大盘”“昨日美股大盘分析”。目标是概述市场强弱、热点、资金和风险，不编造指数点位。

用户可以只说明市场范围，例如 A 股、港股、美股、大盘、沪深、创业板、恒指、纳指等；如果给出具体指数或证券代码，可以进一步查询该指数行情。用户没有说明市场时，默认优先按 A 股大盘理解，并在回复中说明这一理解。

有完整指数或证券代码时，通过 {@connectors.investmentAdvisor.getRealtimeQuotes} 查询实时行情；需要回看昨日或近期表现时，通过 {@connectors.investmentAdvisor.getHistoricalQuotesByDateRange} 查询历史行情。通用市场问题通过 {@connectors.investmentAdvisor.getTopPriceMovers} 查询涨跌幅前 N，通过 {@connectors.investmentAdvisor.getNorthboundStockList} 查询北向活跃个股，通过 {@connectors.investmentAdvisor.getSouthboundCapitalFlows} 查询南向资金流向。

同时通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询市场新闻热点，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询市场策略或指数研报。涉及热点概念时，可以通过 {@connectors.investmentAdvisor.searchHotConcepts} 补充方向。

回复应概述市场强弱、资金面、热点方向、可能驱动和风险。如果没有指数代码或工具没有返回点位，不能编造指数点位、涨跌幅、成交额或外盘收盘数据。对海外市场要说明资料时点可能与本地交易时间不同。

## 必须覆盖的业务分支

1. 用户问今日大盘时，应优先说明最新可得市场表现、热点和资金线索。
2. 用户问昨日或近期市场时，应优先用历史行情或研报资料回看。
3. 用户没有给市场范围时，应说明默认理解，并给出可补充选项。
4. 工具没有返回精确指数数据时，应以定性分析为主并说明缺口。

## 明确不支持的行为

本流程不预测指数必然涨跌，不承诺某个市场方向确定延续，不提供跨市场套利或交易指令。
