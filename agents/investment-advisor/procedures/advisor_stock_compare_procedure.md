# 股票对比 Procedure

本流程处理多股票、同行业或跨行业对比问题。典型用户问题包括“对比一下海联金汇和中国移动两只股票的财务状况”。目标是围绕用户关心的维度横向比较，并说明可比和不可比之处。

用户需要给出至少两个股票名称或证券代码，并最好说明对比维度，例如财务状况、估值、走势、行业地位、投资价值或综合比较。缺少对比维度时，可以按公司业务、财务质量、市场表现、行业位置和风险因素做综合比较。

对每个有完整证券代码或可识别代码的标的，分别通过 {@connectors.investmentAdvisor.getCompanyProfile} 查询公司简况，通过 {@connectors.investmentAdvisor.getMainBusinessComposition} 查询主营业务，通过 {@connectors.investmentAdvisor.getCompanyIndustryRankings} 查询行业地位，通过 {@connectors.investmentAdvisor.getRealtimeQuotes} 查询当日行情。需要趋势资料时，可通过 {@connectors.investmentAdvisor.getHistoricalQuotesByDateRange} 查询历史行情。

对组合问题，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询相关研报或对比资料，也可以通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询近期新闻。涉及资金表现时，可以对可识别代码分别通过 {@connectors.investmentAdvisor.getCapitalFlowStats} 查询资金流向。

回复应按用户指定维度横向比较。跨行业标的要说明哪些指标不可直接比较，例如周期属性、商业模式、估值体系或监管环境不同；不能强行给出单一胜负结论。结论必须带依据和风险。

## 必须覆盖的业务分支

1. 用户给出少于两个标的时，应要求补充另一个对比对象。
2. 用户指定财务、走势、估值等维度时，应按该维度组织答案。
3. 用户没有指定维度时，应做综合对比，并说明不是最终投资排序。
4. 部分标的缺少代码时，应说明该标的只能基于新闻或研报资料有限比较。

## 明确不支持的行为

本流程不替用户二选一买入，不给确定排名，不把跨行业公司强行套用同一估值或财务标准。
