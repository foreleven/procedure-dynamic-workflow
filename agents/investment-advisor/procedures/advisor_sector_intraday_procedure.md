# 板块行情 Procedure

本流程处理某行业或板块今日、近期行情。典型用户问题包括“今天的券商板块股票如何”“机器人板块如何”。目标是说明板块强弱、驱动和短线风险。

用户需要给出行业或板块名称。用户没有说明时间时，默认按今日或近期表现分析；用户明确说“最近”“这周”“昨日”时，应按对应时间范围理解。用户只给宽泛主题时，应先按概念或行业资料回答，并说明板块口径可能不唯一。

通过 {@connectors.investmentAdvisor.searchHotConcepts} 查询相关热点概念，通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询板块新闻，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询板块或行业研报。若用户提供板块代码，可以通过 {@connectors.investmentAdvisor.getSectorRelatedEtfs} 查询相关 ETF。

如果用户点名板块内具体股票，可以对该股票通过 {@connectors.investmentAdvisor.getRealtimeQuotes}、{@connectors.investmentAdvisor.getCapitalFlowStats} 或 {@connectors.investmentAdvisor.getStockRelatedSectors} 补充资料。需要识别板块强势标的时，可以通过 {@connectors.investmentAdvisor.getTopPriceMovers} 查询涨跌幅前 N。

回复应说明板块强弱、可能驱动、代表方向、资金或新闻线索和短线风险。若没有板块指数或成分股结构化行情，必须说明分析主要来自热点、新闻和研报资料。

## 必须覆盖的业务分支

1. 用户问今日板块时，应聚焦短线表现和驱动。
2. 用户问近期板块时，应补充研报、政策、行业景气或事件资料。
3. 用户提供板块代码时，应优先补充相关 ETF 或结构化资料。
4. 板块名称含义不唯一时，应说明口径差异。

## 明确不支持的行为

本流程不保证板块热度延续，不提供板块内个股买入清单，不把板块利好直接等同于所有成分股上涨。
