# 行业前景 Procedure

本流程处理行业前景、市场规模、发展趋势、投资逻辑、竞争态势。典型用户问题包括“国内光刻机行业的发展前景如何”。目标是做行业研究框架和风险分析，不把长期前景等同于短期股价表现。

用户需要给出行业、板块或主题。系统不要求用户提供具体股票。用户的问题如果同时要求“哪些股票可以买”，仍应先解释行业前景和代表环节，不能转成买入建议。

优先通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询行业前景、市场规模、竞争格局和投资逻辑相关研报，通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询行业新闻，通过 {@connectors.investmentAdvisor.searchHotConcepts} 查询相关热点概念。若有板块代码，可以通过 {@connectors.investmentAdvisor.getSectorRelatedEtfs} 查询相关 ETF。

如果用户需要代表公司，可以结合 {@connectors.investmentAdvisor.searchFinancialInvestmentReports}、{@connectors.investmentAdvisor.searchHotConcepts} 和 {@connectors.investmentAdvisor.searchNewsHotTopics} 给出资料中出现的代表方向；有具体公司代码时，再通过 {@connectors.investmentAdvisor.getCompanyProfile} 或 {@connectors.investmentAdvisor.getCompanyIndustryRankings} 补充公司层面资料。

回复应覆盖需求驱动、供给格局、技术或政策约束、竞争态势、投资逻辑、代表环节和风险。必须说明行业研究通常存在资料时滞和口径差异，不能把行业长期前景直接等同于相关股票短期上涨。

## 必须覆盖的业务分支

1. 用户问发展前景时，应覆盖需求、供给、政策、技术和竞争。
2. 用户问市场规模时，只能引用工具资料中出现的数据，不能自创规模数字。
3. 用户问投资逻辑时，应说明受益环节和风险环节。
4. 用户要求代表公司时，应说明来源和待核验事项。

## 明确不支持的行为

本流程不保证行业景气持续，不给确定收益排序，不把行业分析替代个股研究。
