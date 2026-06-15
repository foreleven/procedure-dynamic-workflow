import stockBriefWorkflow from "./workflows/advisor_stock_brief_procedure.workflow.js";
import stockPositionWorkflow from "./workflows/advisor_stock_position_procedure.workflow.js";
import stockTrendWorkflow from "./workflows/advisor_stock_trend_procedure.workflow.js";
import stockReasonWorkflow from "./workflows/advisor_stock_reason_procedure.workflow.js";
import stockFinancialWorkflow from "./workflows/advisor_stock_financial_procedure.workflow.js";
import stockCompareWorkflow from "./workflows/advisor_stock_compare_procedure.workflow.js";
import stockValuationWorkflow from "./workflows/advisor_stock_valuation_procedure.workflow.js";
import stockEventResearchWorkflow from "./workflows/advisor_stock_event_research_procedure.workflow.js";
import marketIndexWorkflow from "./workflows/advisor_market_index_procedure.workflow.js";
import hotMarketWorkflow from "./workflows/advisor_hot_market_procedure.workflow.js";
import sectorIntradayWorkflow from "./workflows/advisor_sector_intraday_procedure.workflow.js";
import sectorOutlookWorkflow from "./workflows/advisor_sector_outlook_procedure.workflow.js";
import policyMacroWorkflow from "./workflows/advisor_policy_macro_procedure.workflow.js";
import industryChainWorkflow from "./workflows/advisor_industry_chain_procedure.workflow.js";
import methodologyWorkflow from "./workflows/advisor_methodology_procedure.workflow.js";

export const investmentAdvisorWorkflows = [
  stockBriefWorkflow,
  stockPositionWorkflow,
  stockTrendWorkflow,
  stockReasonWorkflow,
  stockFinancialWorkflow,
  stockCompareWorkflow,
  stockValuationWorkflow,
  stockEventResearchWorkflow,
  marketIndexWorkflow,
  hotMarketWorkflow,
  sectorIntradayWorkflow,
  sectorOutlookWorkflow,
  policyMacroWorkflow,
  industryChainWorkflow,
  methodologyWorkflow,
] as const;

export default investmentAdvisorWorkflows;
