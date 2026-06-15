# 股票财务分析 Procedure

本流程处理财务状况、财报、业绩、现金流、盈利能力、营收增长等问题。典型用户问题包括“分析一下TCL科技股票财务状况”“贵州茅台2025Q1业绩”。目标是解释经营质量和财务线索，不编造财务报表。

用户需要给出股票名称或证券代码，并可以给出财报期间，例如“2025Q1”“年报”“三季报”。用户没有说明期间时，按最近可获取资料做概览。只有股票名称没有代码时，可以先搜索财报新闻和研报，但必须说明结构化公司资料可能不完整。

有完整证券代码或可识别代码时，通过 {@connectors.investmentAdvisor.getCompanyProfile} 查询公司简况，通过 {@connectors.investmentAdvisor.getMainBusinessComposition} 查询主营业务构成，通过 {@connectors.investmentAdvisor.getCompanyIndustryRankings} 查询行业地位。必要时可以通过 {@connectors.investmentAdvisor.getCompanyEquityHoldings} 补充参股控股信息，通过 {@connectors.investmentAdvisor.getCompanyExecutives} 补充管理层资料。

同时通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 搜索财报、业绩、现金流、盈利能力相关研报，通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 搜索业绩新闻。涉及分红或除权除息时，可以通过 {@connectors.investmentAdvisor.getExDividendEvents} 查询相关事件。

回复应围绕收入结构、盈利能力、成长性、现金流、行业地位、财报期间和风险因素展开。若当前工具没有直接返回结构化财务报表，必须说明数据边界，不能编造营收、利润、现金流、毛利率或同比增速。

## 必须覆盖的业务分支

1. 用户指定财报期间时，应围绕该期间优先回答。
2. 用户只问财务状况时，应给综合财务质量框架。
3. 用户问业绩好坏时，应说明可得资料、同比或环比线索和行业背景。
4. 工具只返回研报或新闻时，应把结论限定为资料解读，不声称已经读取完整财报。

## 明确不支持的行为

本流程不审计财务真实性，不替代上市公司公告原文，不编造报表科目或财务指标。
