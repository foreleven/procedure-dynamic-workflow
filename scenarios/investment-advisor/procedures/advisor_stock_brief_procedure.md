# 股票简析 Procedure

本流程处理裸股票名、股票代码，以及“分析一下”“怎么样”这类泛化股票分析请求。典型用户问题包括“漫步者”“300782”“分析下比亚迪”。目标是给出简洁研究摘要，而不是给出买卖指令。

用户需要至少给出一个股票名称或证券代码。用户只给股票名称时，可以先通过 {@connectors.investmentAdvisor.searchNewsHotTopics} 查询相关新闻，通过 {@connectors.investmentAdvisor.searchFinancialInvestmentReports} 查询相关研报或投资资料；同时必须提示缺少证券代码会影响行情、资金流和公司资料的精确性。

用户给出完整证券代码或可识别的 A 股数字代码时，优先通过 {@connectors.investmentAdvisor.getRealtimeQuotes} 查询当日行情，通过 {@connectors.investmentAdvisor.getTechnicalIndicatorSignals} 查询技术指标信号，通过 {@connectors.investmentAdvisor.getCapitalFlowStats} 查询资金流向统计，通过 {@connectors.investmentAdvisor.getCompanyProfile} 查询公司简况。需要观察近期表现时，可以通过 {@connectors.investmentAdvisor.getHistoricalQuotesByDateRange} 查询历史行情。

如果用户追问“属于什么板块”“蹭什么概念”，可以通过 {@connectors.investmentAdvisor.getStockRelatedSectors} 查询个股关联板块；如果用户追问业务来源，可以通过 {@connectors.investmentAdvisor.getMainBusinessComposition} 查询主营业务。

回复应覆盖公司或业务基本情况、行情和技术面、资金面、近期信息、主要风险和可继续深挖的问题。资料不足时要明确说明哪些结论来自新闻或研报线索，哪些结论需要完整代码或后续公告验证。不能把简析说成个性化投资建议。

## 必须覆盖的业务分支

1. 用户只给股票名时，可以先做有限研究，但必须说明代码缺口。
2. 用户给出股票代码时，应优先补充行情、技术、资金流和公司资料。
3. 用户只问“怎么样”时，应给综合摘要，不直接转成买入或卖出建议。
4. 工具没有返回关键资料时，回复必须说明数据缺口，不能补写行情或财务数值。

## 明确不支持的行为

本流程不判断用户是否适合买入，不读取用户账户，不替用户设定仓位，也不承诺目标价或收益。
