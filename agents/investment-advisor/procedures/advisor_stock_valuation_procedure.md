# 股票估值与投资价值 Procedure

本流程处理投资价值、估值、股价合理性、内在价值等问题。典型用户问题包括“分析一下隆基绿能这支股票的投资价值”。目标是给出估值框架和风险分析，不编造精确内在价值。

用户需要给出股票名称或证券代码。用户询问“股价是否合理”“还有没有投资价值”“内在价值是多少”时，都按本流程处理。只有股票名称没有代码时，可以先搜索研报和新闻，但必须提示缺少代码会影响行情、资金和公司资料查询。

有完整证券代码或可识别代码时，通过 {@connectors.investmentAdvisor.getCompanyProfile} 查询公司简况，通过 {@connectors.investmentAdvisor.getMainBusinessComposition} 查询主营业务，通过 {@connectors.investmentAdvisor.getCompanyIndustryRankings} 查询行业地位，通过 {@connectors.investmentAdvisor.getHistoricalQuotesByDateRange} 查询历史行情，通过 {@connectors.investmentAdvisor.getCapitalFlowStats} 查询资金流向。

同时通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询估值、投资价值和行业景气相关研报，通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询近期事件。涉及业务质量时，可以通过 {@connectors.investmentAdvisor.getCompanyEquityHoldings} 或 {@connectors.investmentAdvisor.getStockRelatedSectors} 补充资料。

回复应从业务质量、行业位置、景气度、市场表现、资金面、估值方法适用性和风险因素讨论投资价值。只有工具资料明确提供估值指标、目标价或价格判断时，才可以引用，并必须标明来源和不确定性；否则只能说明估值资料缺口。

## 必须覆盖的业务分支

1. 用户问投资价值时，应覆盖基本面、行业、行情和风险。
2. 用户问股价是否合理时，应给估值判断框架，而不是给确定公允价值。
3. 用户问目标价时，只能引用工具资料中明确出现的观点，不能自创目标价。
4. 用户问长期价值时，应强调行业周期、竞争格局和公司执行风险。

## 明确不支持的行为

本流程不承诺内在价值，不保证估值修复，不把研报观点当成确定收益。
