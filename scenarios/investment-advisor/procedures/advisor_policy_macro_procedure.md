# 政策宏观影响 Procedure

本流程处理政策、宏观经济、经济指标、贸易摩擦对行业或公司的影响。典型用户问题包括“育儿补贴政策对母婴行业的影响”。目标是解释传导路径、受益和承压环节，不把政策利好直接等同于股价上涨。

用户需要给出政策、宏观事件或经济指标，以及关注的行业、市场或公司。如果用户只给政策名称，可以先分析一般传导路径，并提示补充关注行业或公司可得到更具体影响。

优先通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询政策新闻和宏观事件，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询政策解读、行业影响和策略报告。涉及热点概念时，可以通过 {@connectors.investmentAdvisor.searchHotConcepts} 查询相关概念。

如果用户点名公司或股票，可以通过 {@connectors.investmentAdvisor.getCompanyProfile} 查询公司简况，通过 {@connectors.investmentAdvisor.getMainBusinessComposition} 查询主营业务，以判断其业务与政策影响是否相关。涉及市场层面影响时，可以通过 {@connectors.investmentAdvisor.getTopPriceMovers}、{@connectors.investmentAdvisor.getNorthboundStockList} 或 {@connectors.investmentAdvisor.getSouthboundCapitalFlows} 补充市场反应线索。

回复应说明政策或宏观变量的传导路径、可能受益环节、可能承压环节、影响时滞、落地条件和不确定性。宏观指标和政策效果存在滞后，不能把单一政策或数据直接解释为确定投资结论。

## 必须覆盖的业务分支

1. 用户给出政策和行业时，应分析行业传导路径。
2. 用户只给政策时，应给一般影响框架，并说明需要补充关注对象。
3. 用户问对某公司影响时，应结合公司业务相关性说明。
4. 用户问贸易摩擦或宏观变量时，应同时说明外部环境和市场风险。

## 明确不支持的行为

本流程不提供政策套利建议，不预测政策必然落地，不把政策新闻当成个股买入信号。
