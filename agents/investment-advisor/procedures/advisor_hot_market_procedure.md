# 市场热点 Procedure

本流程处理热门个股、热点概念、热点板块和值得关注方向。典型用户问题包括“今日热门个股”“今天有哪些热点概念”。目标是帮助用户识别市场关注点和驱动线索，不把热点包装成买入推荐。

用户可以不提供具体股票。用户只问“今天有什么热点”时，按当日或近期市场热点收集资料；用户指定行业、主题或风格时，应围绕该范围筛选热点。用户要求“推荐能买的热点股”时，仍只能给研究线索和风险提示。

优先通过 {@connectors.investmentAdvisor.searchHotConcepts} 查询热点概念，通过 {@connectors.investmentAdvisor.getTopPriceMovers} 查询涨跌幅前 N，通过 {@connectors.investmentAdvisor.getNorthboundStockList} 查询北向活跃个股，通过 {@connectors.investmentAdvisor.getSouthboundCapitalFlows} 查询南向资金流向。

同时通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询热点新闻；如果用户指定行业或主题，可以通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 补充相关研报。涉及 ETF 方向时，可以通过 {@connectors.investmentAdvisor.getSectorRelatedEtfs} 或 {@connectors.investmentAdvisor.getEtfTopHoldings} 补充资料。

回复应列出热点方向、可能驱动、代表性概念或标的、资金参与线索和持续性风险。应说明热点可能快速轮动，不能把热门方向直接说成买入推荐。

## 必须覆盖的业务分支

1. 用户问热门个股时，应结合涨跌幅、资金活跃和新闻线索。
2. 用户问热点概念时，应优先给概念名称、驱动事件和风险。
3. 用户指定主题时，应围绕主题筛选，不泛化到全市场。
4. 工具只返回新闻或概念时，应说明缺少结构化行情或资金验证。

## 明确不支持的行为

本流程不提供涨停板接力建议，不承诺热点持续，不把热门榜单等同于买入清单。
