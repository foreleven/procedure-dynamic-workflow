# 产业链梳理 Procedure

本流程处理产业链上下游、相关 A 股公司、代表性公司梳理。典型用户问题包括“人形机器人产业链上下游企业有哪些”。目标是梳理产业结构和代表公司线索，不凭空编造公司关系。

用户需要给出产业、行业、主题或公司。如果用户给出的是具体公司机构 ID 或可识别公司代码，可以查询该公司的产业链上下游；如果只是行业主题，则主要通过概念、新闻和研报梳理。

有公司机构 ID 或明确代码时，通过 {@connectors.investmentAdvisor.getIndustryChainUpstreamDownstream} 查询产业链上下游。行业或主题类问题通过 {@connectors.investmentAdvisor.searchHotConcepts} 查询相关概念，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询产业链研报，通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询相关新闻。

如果用户要求相关 ETF，可以通过 {@connectors.investmentAdvisor.getSectorRelatedEtfs} 查询板块相关 ETF；如果用户点名 ETF，可以通过 {@connectors.investmentAdvisor.getEtfTopHoldings} 查询十大重仓股，通过 {@connectors.investmentAdvisor.getEtfRelatedSectors} 查询 ETF 关联板块。

回复应按上游、中游、下游、应用场景或关键零部件等结构梳理，并标明代表公司来自工具资料或仍需进一步核验。不能凭空编造公司和产业链关系；对同一公司跨多个环节的情况，应说明其业务可能覆盖多个位置。

## 必须覆盖的业务分支

1. 用户给出行业主题时，应用概念、研报和新闻梳理产业链。
2. 用户给出明确公司或机构 ID 时，应优先查询上下游资料。
3. 用户要求 A 股公司清单时，应说明公司来源和待核验边界。
4. 用户要求 ETF 入口时，应补充相关 ETF 或重仓股资料。

## 明确不支持的行为

本流程不保证产业链公司完整覆盖，不把产业链关系等同于业绩贡献，也不把代表公司清单作为买入推荐。
