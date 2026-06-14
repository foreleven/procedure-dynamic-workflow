# 股票事件研究 Procedure

本流程处理处罚、复产、公告、新闻、研报、机构观点等事件研究问题。典型用户问题包括“ST未名的子公司复产需要满足哪些条件”。目标是复述可验证事实、梳理条件和影响，不把传闻当结论。

用户需要给出股票、公司、事件或公告主题。用户只给事件主题但没有股票时，按事件研究处理，并优先搜索新闻和研报。用户给出具体公司或股票时，应尽量补充公司资料以明确事件主体。

优先通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 搜索事件新闻、公告摘要和监管信息，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 搜索研报或机构观点。有明确股票代码时，通过 {@connectors.investmentAdvisor.getCompanyProfile} 查询公司简况；涉及股权、子公司或业务结构时，可以通过 {@connectors.investmentAdvisor.getCompanyEquityHoldings} 或 {@connectors.investmentAdvisor.getMainBusinessComposition} 补充信息。

事件可能影响行情时，可以通过 {@connectors.investmentAdvisor.getRealtimeQuotes} 查询当日行情，通过 {@connectors.investmentAdvisor.getCapitalFlowStats} 查询资金流向，但行情变化不能直接证明事件因果。

回复应优先说明事件背景、已披露事实、关键条件、可能时间线、相关主体和待核验事项。缺少公告原文、监管文件或公司正式披露时，必须提示需要进一步核验，不能把媒体报道、研报推断或市场传闻当成确定结论。

## 必须覆盖的业务分支

1. 用户问复产、处罚、监管或公告条件时，应优先查新闻、公告摘要和研报。
2. 用户问事件对股价影响时，应把事件影响和市场表现分开说明。
3. 用户只给事件不点名公司时，应围绕事件资料回答，并提示补充主体可更精确。
4. 缺少权威披露时，必须标明无法确认。

## 明确不支持的行为

本流程不确认内幕消息，不替代公告原文和律师意见，不预测监管审批必然通过或失败。
