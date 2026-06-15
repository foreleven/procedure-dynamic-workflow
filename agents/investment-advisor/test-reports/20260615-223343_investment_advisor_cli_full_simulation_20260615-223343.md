# Workflow Scenario Test Report

- Session: `investment_advisor_cli_full_simulation_20260615-223343` (review run id; CLI did not print internal session ids)
- Agent: `agents/investment-advisor`
- User: `user_feng`
- Goal: Run all `agent.yaml` cases through the real CLI runtime and evaluate routing plus response quality.
- Command: `npm run chat -- agents/investment-advisor --all-cases --no-stream`
- Exit code: `0`
- Score: `82/100`
- Grade: `needs_review`
- Model: not printed by CLI
- Started at: `2026-06-15 22:33:43 +0800` (from log filename)
- Finished at: approximately `2026-06-15 22:40:58 +0800` (case durations summed)
- Raw evidence: `/tmp/investment-advisor-cli-20260615-223343.log`

## Summary

The CLI completed all 21 manifest cases without a runtime error. Routing quality is strong: all 15 single-workflow cases mapped to the expected workflow, and all 6 mixed-intent cases emitted the expected workflow sections.

Response quality is mostly acceptable, but the run needs review because one mixed market case violated the data-boundary expectation by emitting precise index points, percentage moves, and turnover after another section stated exact structured data was unavailable. Two mixed cases also show cross-workflow consistency issues around data availability or factual framing.

- Routing hit rate: `21/21`
- Mixed-intent hit rate: `6/6`
- Response verdicts: `18 pass`, `2 warn`, `1 fail`
- Runtime errors: none observed
- Main bug signals: `unsupported_precise_market_data`, `cross_workflow_data_boundary_conflict`, `parallel_workflow_fact_inconsistency`

Duration distribution:

- Total duration: `435.42s`
- Turn count: `21`
- Min: `10.92s`
- Max: `30.82s`
- Avg: `20.73s`
- P50: `21.29s`
- P90: `28.81s`

## Score Breakdown

- Goal completion: `35/40` - all cases ran to completion and routed correctly, but one expected response contract failed.
- Expected satisfaction: `27/30` - 18 pass, 2 warn, 1 fail.
- Business boundary safety: `12/20` - investment disclaimers were generally present, but precise market data appeared where the case expected no invented points,涨跌幅 or成交额.
- Conversation quality: `8/10` - replies were readable and actionably structured, with some duplicated or inconsistent mixed-workflow sections.

## Loaded Workflows

- `advisor_stock_brief_procedure@1.0.0`
- `advisor_stock_position_procedure@1.0.0`
- `advisor_stock_trend_procedure@1.0.0`
- `advisor_stock_reason_procedure@1.0.0`
- `advisor_stock_financial_procedure@1.0.0`
- `advisor_stock_compare_procedure@1.0.0`
- `advisor_stock_valuation_procedure@1.0.0`
- `advisor_stock_event_research_procedure@1.0.0`
- `advisor_market_index_procedure@1.0.0`
- `advisor_hot_market_procedure@1.0.0`
- `advisor_sector_intraday_procedure@1.0.0`
- `advisor_sector_outlook_procedure@1.0.0`
- `advisor_policy_macro_procedure@1.0.0`
- `advisor_industry_chain_procedure@1.0.0`
- `advisor_methodology_procedure@1.0.0`

## Transcript

### Turn 1 - `advisor_stock_brief_procedure`

- Send: `分析下比亚迪`
- Expected: 系统应围绕比亚迪给出投资研究摘要，说明依据来自可用行情、新闻或研报数据，并提示不是确定买卖建议。
- Response workflow ids: `advisor_stock_brief_procedure` (inferred from single-workflow case id)
- Actual summary: Provided a BYD research brief covering business, technical/market conditions, institutions, recent technology/overseas/storage/product-cycle information, key risks, and an investment-risk disclaimer.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `21.62s`
- Verdict: `pass`
- Reason: Satisfies the requested research-summary shape and includes data boundary plus non-advice disclaimer.
- Bug signals: []

### Turn 2 - `advisor_stock_position_procedure`

- Send: `圣邦股份股票现在可以进吗`
- Expected: 系统应提供条件化买入或观望策略、风险控制和需要确认的信号，不能直接给无条件买入指令。
- Response workflow ids: `advisor_stock_position_procedure` (inferred from single-workflow case id)
- Actual summary: Returned conditional entry, holding/waiting, exit/stop-loss, and risk-control criteria instead of a direct buy instruction.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `25.75s`
- Verdict: `pass`
- Reason: The reply is framed as a conditional strategy and avoids unconditional trade advice.
- Bug signals: []

### Turn 3 - `advisor_stock_trend_procedure`

- Send: `紫金矿业明日预测`
- Expected: 系统应给出短期情景分析和风险提示，不能保证明日涨跌。
- Response workflow ids: `advisor_stock_trend_procedure` (inferred from single-workflow case id)
- Actual summary: Explicitly says deterministic next-day movement cannot be given, then provides short-term bullish, pullback, and risk-release scenarios with risk notes.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `15.71s`
- Verdict: `pass`
- Reason: Uses scenario analysis and avoids guaranteeing tomorrow's movement.
- Bug signals: []

### Turn 4 - `advisor_stock_reason_procedure`

- Send: `300322涨停原因`
- Expected: 系统应结合行情、资金、新闻或热点信息解释可能原因，并区分已证实信息和待核验因素。
- Response workflow ids: `advisor_stock_reason_procedure` (inferred from single-workflow case id)
- Actual summary: First states current data does not show a limit-up, then discusses historical limit-up/abnormal-move drivers, flags date ambiguity, and separates items needing verification.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `15.06s`
- Verdict: `pass`
- Reason: Correctly challenges the premise and separates current facts from historical interpretation.
- Bug signals: []

### Turn 5 - `advisor_stock_financial_procedure`

- Send: `贵州茅台2025Q1业绩`
- Expected: 系统应围绕贵州茅台 2025Q1 业绩或财务信息分析，并说明数据边界和风险。
- Response workflow ids: `advisor_stock_financial_procedure` (inferred from single-workflow case id)
- Actual summary: Covers Q1 revenue, profit, product/channel structure, margin, cash flow, industry position, risks, and data-boundary notes.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `17.13s`
- Verdict: `pass`
- Reason: Meets the financial-analysis expectation and includes boundary/risk language.
- Bug signals: []

### Turn 6 - `advisor_stock_compare_procedure`

- Send: `对比一下海联金汇和中国移动两只股票的财务状况`
- Expected: 系统应分别比较两家公司财务或业务情况，说明可比维度和不可比之处。
- Response workflow ids: `advisor_stock_compare_procedure` (inferred from single-workflow case id)
- Actual summary: Compares scale, profitability, balance sheet, cash flow, investment activity, and cross-industry differences, then avoids a simplistic good/bad ranking.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `17.40s`
- Verdict: `pass`
- Reason: Clearly identifies comparable and non-comparable dimensions.
- Bug signals: []

### Turn 7 - `advisor_stock_valuation_procedure`

- Send: `分析一下隆基绿能这支股票的投资价值`
- Expected: 系统应从业务质量、行业位置、景气度、市场表现和估值风险讨论投资价值，不能编造精确内在价值。
- Response workflow ids: `advisor_stock_valuation_procedure` (inferred from single-workflow case id)
- Actual summary: Discusses LONGi's business quality, industry position, cycle status, valuation-method limits, data gaps, and risks without giving a made-up intrinsic value.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `25.32s`
- Verdict: `pass`
- Reason: Meets the valuation-framework requirement and states why precise valuation is not available.
- Bug signals: []

### Turn 8 - `advisor_stock_event_research_procedure`

- Send: `ST未名的子公司复产需要满足哪些条件`
- Expected: 系统应优先围绕公告、新闻或研报事实说明复产条件，缺少原文时提示需要进一步核验。
- Response workflow ids: `advisor_stock_event_research_procedure` (inferred from single-workflow case id)
- Actual summary: Explains likely复产条件 around整改, regulatory inspection/acceptance, quality-system restoration, and explicitly notes the lack of official original text.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `17.45s`
- Verdict: `pass`
- Reason: Keeps the answer tied to available disclosure and marks inferred conditions as needing verification.
- Bug signals: []

### Turn 9 - `advisor_market_index_procedure`

- Send: `今日大盘`
- Expected: 系统应概述大盘、资金面、热点方向和风险；没有指数代码时不能编造指数点位。
- Response workflow ids: `advisor_market_index_procedure` (inferred from single-workflow case id)
- Actual summary: Gives a qualitative A-share market overview,资金面,热点方向, possible drivers, and risks without emitting exact index points.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `19.77s`
- Verdict: `pass`
- Reason: Matches the expected qualitative market overview and does not invent point levels.
- Bug signals: []

### Turn 10 - `advisor_hot_market_procedure`

- Send: `今天有哪些热点概念`
- Expected: 系统应列出热点概念或方向、驱动因素和持续性风险。
- Response workflow ids: `advisor_hot_market_procedure` (inferred from single-workflow case id)
- Actual summary: Lists AI hardware, chips, humanoid robots, "six networks" infrastructure, and commercial aerospace with drivers, risk, and data-confirmation needs.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `13.79s`
- Verdict: `pass`
- Reason: Provides directions, drivers, and sustainability risks, and avoids claiming a precise real-time ranking.
- Bug signals: []

### Turn 11 - `advisor_sector_intraday_procedure`

- Send: `今天的券商板块股票如何`
- Expected: 系统应说明券商板块当日或近期强弱、可能驱动和短线风险。
- Response workflow ids: `advisor_sector_intraday_procedure` (inferred from single-workflow case id)
- Actual summary: Describes brokerage-sector recent strength, likely policy/fundamental/funding drivers, and short-term pullback risks, while saying the data is from news/research rather than live ticks.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `10.92s`
- Verdict: `pass`
- Reason: Satisfies the sector-strength, driver, and risk requirements.
- Bug signals: []

### Turn 12 - `advisor_sector_outlook_procedure`

- Send: `国内光刻机行业的发展前景如何`
- Expected: 系统应说明光刻机行业前景、驱动、竞争态势、投资逻辑和风险。
- Response workflow ids: `advisor_sector_outlook_procedure` (inferred from single-workflow case id)
- Actual summary: Covers domestic substitution, demand drivers, supply/technical constraints, global and domestic competition, investment logic, and risks.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `21.29s`
- Verdict: `pass`
- Reason: The answer covers all expected industry-outlook dimensions.
- Bug signals: []

### Turn 13 - `advisor_policy_macro_procedure`

- Send: `育儿补贴政策对母婴行业的影响`
- Expected: 系统应说明政策传导路径、受益和承压环节、时滞和不确定性。
- Response workflow ids: `advisor_policy_macro_procedure` (inferred from single-workflow case id)
- Actual summary: Explains the fiscal-to-household-to-consumption transmission path, beneficiary categories, pressure points, lag, and uncertainty.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `16.42s`
- Verdict: `pass`
- Reason: Directly answers the policy transmission and uncertainty expectation.
- Bug signals: []

### Turn 14 - `advisor_industry_chain_procedure`

- Send: `人形机器人产业链上下游企业有哪些`
- Expected: 系统应按产业链上下游或关键环节梳理相关公司，并说明信息需进一步核验。
- Response workflow ids: `advisor_industry_chain_procedure` (inferred from single-workflow case id)
- Actual summary: Breaks the humanoid robot chain into upstream parts, midstream integrators, and downstream scenarios, with representative companies and verification disclaimers.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `11.69s`
- Verdict: `pass`
- Reason: Satisfies the upstream/downstream company-mapping requirement.
- Bug signals: []

### Turn 15 - `advisor_methodology_procedure`

- Send: `推荐一些解读建材板块资金流向与宏观经济数据的方法范本`
- Expected: 系统应提供可复用的方法步骤、指标清单、解释方式和验证注意事项。
- Response workflow ids: `advisor_methodology_procedure` (inferred from single-workflow case id)
- Actual summary: Provides a reusable methodology with资金流指标, macro/policy indicators,建材子行业 metrics, cross-validation steps, and risks.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `21.49s`
- Verdict: `pass`
- Reason: It is a reusable framework and includes validation/interpretation cautions.
- Bug signals: []

### Turn 16 - `mixed_position_valuation`

- Send: `比亚迪现在能不能买，估值贵不贵也顺便看一下`
- Expected: 系统应同时进入仓位策略和估值研究，分别给出条件化买入/观望逻辑和估值风险分析，不能给无条件买入指令或自创精确目标价。
- Response workflow ids: `advisor_stock_position_procedure`, `advisor_stock_valuation_procedure`
- Actual summary: The position section gives conditional buy/wait and risk-control framing. The valuation section covers business quality, competition, valuation metrics, and risk; target prices are attributed to机构/媒体 rather than invented as the assistant's own intrinsic value.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `24.93s`
- Verdict: `pass`
- Reason: Both expected workflow sections appeared and the advice remained conditional.
- Bug signals: []

### Turn 17 - `mixed_compare_financial`

- Send: `对比一下贵州茅台和五粮液的财务状况，重点看盈利能力和现金流`
- Expected: 系统应同时进入股票对比和财务研究，横向比较两家公司并围绕盈利能力、现金流和数据边界展开，不能强行给出单一投资排序。
- Response workflow ids: `advisor_stock_compare_procedure`, `advisor_stock_financial_procedure`
- Actual summary: Both sections compare profitability and cash flow and avoid a single investment ranking. However, the two sections conflict on which company's detailed data is available: one says五粮液 data is available but贵州茅台 detail is missing, while the other says贵州茅台 data is available but五粮液 detail is missing.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `28.81s`
- Verdict: `warn`
- Reason: The high-level expectation is mostly satisfied, but cross-workflow data-boundary inconsistency reduces reliability.
- Bug signals: [`cross_workflow_data_boundary_conflict`]

### Turn 18 - `mixed_market_hot_sector`

- Send: `今日大盘怎么样，有哪些热点概念，券商板块今天表现也说一下`
- Expected: 系统应同时进入大盘、热点概念和券商板块短线分析，分别说明市场强弱、热点驱动和板块风险；没有结构化指数或板块行情时不能编造点位、涨跌幅或成交额。
- Response workflow ids: `advisor_market_index_procedure`, `advisor_hot_market_procedure`, `advisor_sector_intraday_procedure`
- Actual summary: All three expected workflow sections appeared. The market-index and hot-market sections correctly used qualitative or线索级 language, but the sector-intraday section emitted exact index涨幅、点位 and成交额 such as上证指数、深证成指、创业板指 and两市成交额.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `26.70s`
- Verdict: `fail`
- Reason: Violates the explicit case expectation against precise point/percentage/turnover output when structured market data is not established in the CLI-visible evidence.
- Bug signals: [`unsupported_precise_market_data`, `parallel_workflow_fact_inconsistency`]

### Turn 19 - `mixed_policy_industry_chain`

- Send: `育儿补贴政策对母婴行业有什么影响，相关产业链和A股公司也梳理一下`
- Expected: 系统应同时进入政策宏观和产业链梳理，说明政策传导路径、受益和承压环节，并按产业链梳理相关公司线索，不能把公司清单当成买入推荐。
- Response workflow ids: `advisor_policy_macro_procedure`, `advisor_industry_chain_procedure`
- Actual summary: The policy section covers transmission path, beneficiary and pressure links, and uncertainty. The industry-chain section maps upstream/midstream/downstream A-share company lines and marks them as research leads, not recommendations.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `23.32s`
- Verdict: `pass`
- Reason: Both expected workflows are present and company lists are clearly disclaimed as research clues.
- Bug signals: []

### Turn 20 - `mixed_event_reason_trend`

- Send: `宁德时代最新公告怎么看，今天为什么大跌，后市会怎么走`
- Expected: 系统应同时进入事件研究、异动原因和趋势研判，区分公告事实、行情异动线索和后市情景分析，不能把传闻当事实或保证未来涨跌。
- Response workflow ids: `advisor_stock_event_research_procedure`, `advisor_stock_reason_procedure`, `advisor_stock_trend_procedure`
- Actual summary: All three expected sections appeared and generally distinguish official disclosure, market explanations, and future scenarios. The reason/trend sections say the stock was not actually down on the latest trading day, while the event section still discusses "今日乃至近期下跌" causes before that premise is reconciled.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `30.82s`
- Verdict: `warn`
- Reason: The answer avoids guaranteed future movement, but mixed sections should share a consistent premise about whether "today大跌" is true and which item is the latest official公告.
- Bug signals: [`parallel_workflow_fact_inconsistency`]

### Turn 21 - `mixed_methodology_sector_outlook`

- Send: `给我一个分析人工智能行业前景和资金流的方法范本，顺便说说这个行业发展趋势`
- Expected: 系统应同时进入方法论和行业前景研究，提供可复用步骤、指标清单、验证方法，并说明人工智能行业趋势、驱动和风险，不能承诺模型或方法带来收益。
- Response workflow ids: `advisor_methodology_procedure`, `advisor_sector_outlook_procedure`
- Actual summary: The methodology section gives an AI industry/资金流 framework with指标、验证 and风险监测. The outlook section covers industry prospects, trends, capital flow dimensions, and risks without promising returns.
- State: `not captured by CLI`
- Traces: `not captured by CLI`
- Runtime error: none observed
- Duration: `30.02s`
- Verdict: `pass`
- Reason: Both expected workflow outputs are present and the framework avoids return guarantees.
- Bug signals: []

## Final State

`not captured by CLI`

## Reviewer Notes

- This report used CLI output as the source of truth, as required by the updated testing skill for `agent.yaml` cases.
- Compact state and trace phases were not printed by this CLI invocation, so they are recorded as `not captured by CLI` rather than inferred.
- The strongest product issue is not routing; it is cross-workflow answer consistency and data-boundary discipline in mixed market questions.
