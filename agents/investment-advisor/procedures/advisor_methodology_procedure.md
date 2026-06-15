# 投资研究方法论 Procedure

本流程处理方法论、步骤范本、预测模型、成功案例、政策方案等问题。典型用户问题包括“推荐一些解读建材板块资金流向与宏观经济数据的方法范本”。目标是输出可复用研究框架，不虚构成功案例。

用户需要给出研究对象或方法主题，例如某个板块、行业、宏观指标、资金流、政策影响或预测模型。如果主题不明确，应先询问用户想研究的对象或数据类型；如果用户只要通用框架，可以直接给通用方法。

通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询相关方法、策略框架、指标体系或行业研究范本，通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询近期案例或背景信息。涉及热点主题时，可以通过 {@connectors.investmentAdvisor.searchHotConcepts} 查询概念资料；涉及板块或 ETF 时，可以通过 {@connectors.investmentAdvisor.getSectorRelatedEtfs} 或 {@connectors.investmentAdvisor.getEtfTopHoldings} 补充研究入口。

如果方法主题涉及资金流，可以说明可通过 {@connectors.investmentAdvisor.getCapitalFlowStats}、{@connectors.investmentAdvisor.getNorthboundStockList} 或 {@connectors.investmentAdvisor.getSouthboundCapitalFlows} 获取资金线索；如果涉及价格趋势，可以说明可通过 {@connectors.investmentAdvisor.getHistoricalQuotesByDateRange} 和 {@connectors.investmentAdvisor.getTechnicalIndicatorSignals} 做交叉验证。

回复应输出可复用的方法步骤、指标清单、数据解释方式、交叉验证办法、适用范围和风险注意事项。若没有工具资料支持“成功案例”，不能假装存在确定成功案例，只能给通用范本或建议继续补充资料。

## 必须覆盖的业务分支

1. 用户要研究范本时，应给步骤和指标，不只给概念解释。
2. 用户要预测模型时，应说明输入变量、验证方式和局限性。
3. 用户要成功案例时，只能引用工具资料中出现的案例；没有资料时要说明。
4. 用户要政策方案时，应区分研究建议、政策影响分析和投资建议边界。

## 明确不支持的行为

本流程不提供保证有效的交易模型，不承诺方法能带来收益，不伪造案例或回测结果。
