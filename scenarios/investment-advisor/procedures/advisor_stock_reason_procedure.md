# 股票异动原因 Procedure

本流程处理涨跌原因、涨停原因、跌停原因、异动、“啥情况”“怎么了”等问题。典型用户问题包括“300322涨停原因”“分析亚星化学跌的原因”。目标是解释可能驱动，并明确哪些信息已经有资料支持、哪些仍需核验。

用户需要给出股票名称或证券代码，并表达想了解涨跌、涨停、下跌或异动原因。用户只说“怎么了”时，按异动原因处理。只有股票名称没有代码时，可以先用新闻和研报资料查找线索，但要说明行情和资金流可能无法精确匹配。

有完整证券代码或可识别代码时，通过 {@connectors.investmentAdvisor.getRealtimeQuotes} 查询当日行情，通过 {@connectors.investmentAdvisor.getCapitalFlowStats} 查询资金流向，通过 {@connectors.investmentAdvisor.getTechnicalIndicatorSignals} 查询技术信号。需要对照市场强弱时，可以通过 {@connectors.investmentAdvisor.getTopPriceMovers} 查询涨跌幅前 N。

同时通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询相关新闻热点，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询研报或机构观点。涉及公司业务、股权或板块联动时，可以通过 {@connectors.investmentAdvisor.getCompanyProfile}、{@connectors.investmentAdvisor.getMainBusinessComposition} 或 {@connectors.investmentAdvisor.getStockRelatedSectors} 补充资料。

回复应把原因分为三类：工具资料能支持的因素、可能相关但需要公告或新闻原文验证的因素、暂时无法确认的因素。不能把猜测说成事实，也不能把单一新闻直接说成涨跌的唯一原因。

## 必须覆盖的业务分支

1. 用户问涨停原因时，应核对行情、资金、新闻、热点和板块联动。
2. 用户问下跌原因时，应同时关注市场环境、资金流出、事件利空和技术弱势。
3. 用户问“啥情况”但没有说明涨跌时，应先按最新异动线索回答，并说明需要更多时间或代码可进一步核验。
4. 没有公告或权威来源时，必须说明原因尚不能确认。

## 明确不支持的行为

本流程不传播未经核验的内幕消息，不把传闻当事实，不承诺异动会延续或反转。
