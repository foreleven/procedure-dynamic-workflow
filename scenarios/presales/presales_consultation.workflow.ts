import {
  ToolMessage,
  loadWorkflowMetadata,
  type WorkflowContext,
  workflow,
  z,
} from "@pac/workflow";
import type { PresalesConnectorCatalog } from "./connectors.js";

const UseCaseSchema = z.enum([
  "working_capital",
  "inventory",
  "equipment",
  "expansion",
  "invoice_bridge",
]);

const CustomerProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  businessName: z.string(),
  customerType: z.enum(["sme", "individual"]),
  city: z.string(),
  industry: z.string(),
  businessAgeMonths: z.number().int().nonnegative(),
  annualRevenueCents: z.number().int().nonnegative(),
  riskTier: z.enum(["low", "medium", "high"]),
  phone: z.string(),
  email: z.string(),
  contactPermission: z.boolean(),
});

const ExistingRelationshipsSchema = z.object({
  userId: z.string(),
  businessChecking: z.boolean(),
  merchantServices: z.boolean(),
  existingLoanBalanceCents: z.number().int().nonnegative(),
  priorDelinquencies: z.number().int().nonnegative(),
  relationshipMonths: z.number().int().nonnegative(),
});

const AprRangeSchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
});

const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(["credit_line", "term_loan", "equipment_finance"]),
  useCases: z.array(UseCaseSchema),
  minAmountCents: z.number().int().positive(),
  maxAmountCents: z.number().int().positive(),
  minTermMonths: z.number().int().positive(),
  maxTermMonths: z.number().int().positive(),
  minBusinessAgeMonths: z.number().int().nonnegative(),
  minAnnualRevenueCents: z.number().int().nonnegative(),
  aprRangeBps: AprRangeSchema,
  summary: z.string(),
  requiredDocuments: z.array(z.string()),
  fees: z.array(z.string()),
});

const FinancingNeedSchema = z.object({
  requestedAmountCents: z.number().int().positive(),
  useCase: UseCaseSchema,
  termMonths: z.number().int().positive().nullable(),
});

const ConsultationLeadSchema = z.object({
  id: z.string(),
  status: z.enum(["created"]),
  customerId: z.string(),
  productId: z.string(),
  requestedAmountCents: z.number().int().positive(),
  useCase: UseCaseSchema,
  assignedAdvisorName: z.string(),
  createdAt: z.string(),
});

const ProductMatchSchema = z.object({
  product: ProductSchema,
  fit: z.enum(["recommended", "possible", "not_eligible"]),
  reasons: z.array(z.string()),
  gaps: z.array(z.string()),
});

const PresalesStatusSchema = z.enum([
  "collecting",
  "recommending",
  "lead_requested",
  "lead_created",
  "cancelled",
]);

const PresalesStateSchema = z.object({
  status: PresalesStatusSchema,
  requestedAmountCents: z.number().int().positive().nullable(),
  useCase: UseCaseSchema.nullable(),
  termMonths: z.number().int().positive().nullable(),
  selectedProduct: ProductSchema.nullable(),
  lead: ConsultationLeadSchema.nullable(),
});

export type PresalesState = z.infer<typeof PresalesStateSchema>;

type CustomerProfile = z.infer<typeof CustomerProfileSchema>;
type ExistingRelationships = z.infer<typeof ExistingRelationshipsSchema>;
type FinancingNeed = z.infer<typeof FinancingNeedSchema>;
type PresalesProduct = z.infer<typeof ProductSchema>;
type ProductMatch = z.infer<typeof ProductMatchSchema>;
type PresalesContext = WorkflowContext<PresalesConnectorCatalog>;

interface PresalesFacts {
  customer: CustomerProfile;
  relationships: ExistingRelationships | null;
  productCatalog: PresalesProduct[];
}

const presalesInitialState = PresalesStateSchema.parse({
  status: "collecting",
  requestedAmountCents: null,
  useCase: null,
  termMonths: null,
  selectedProduct: null,
  lead: null,
});

const presalesInvalidation = {
  requestedAmountCents: ["selectedProduct"],
  useCase: ["selectedProduct"],
  termMonths: ["selectedProduct"],
} satisfies Partial<Record<keyof PresalesState & string, Array<keyof PresalesState & string>>>;

const metadata = loadWorkflowMetadata(import.meta.url);

const { patch, prefetch, derive, command, render } = workflow<
  PresalesState,
  PresalesConnectorCatalog
>({
  ...metadata,
  stateSchema: PresalesStateSchema,
  state: presalesInitialState,
});

patch({
  progress: "正在理解融资咨询需求",
  state: {
    status: PresalesStatusSchema,
    requestedAmountCents: z.number().int().positive(),
    useCase: UseCaseSchema,
    termMonths: z.number().int().positive(),
    selectedProduct: ProductSchema,
  },
  invalidates: presalesInvalidation,
  instruction: `
Extract only these presales consultation state fields: status, requestedAmountCents, useCase, termMonths, and selectedProduct.

Need extraction:
- Convert financing amounts to integer USD cents. For example, 20 万美元 is 20000000 cents, and 3 万美元 is 3000000 cents.
- Extract useCase only when the message states the business purpose: working_capital, inventory, equipment, expansion, or invoice_bridge.
- Extract termMonths only when the user states a concrete duration.
- When the user changes amount, useCase, or term, set status to collecting unless they are explicitly asking a sales advisor to follow up.

Product selection:
- Set selectedProduct only when the user explicitly selects or names a product already visible in the conversation.
- Do not invent products, ids, rates, eligibility, approvals, or offers.
- Do not set selectedProduct merely because a product is first or recommended.

Status extraction:
- Set status to lead_requested only when the user explicitly asks for a sales advisor, follow-up, application help, or continuing with a human.
- Set status to cancelled only when the user explicitly stops, cancels, or pauses this consultation flow.
- Do not set lead_requested for ordinary questions about rate, documents, fees, eligibility, or product details.

Never produce final replies, chain-of-thought, connector calls, or approval decisions.
`,
});

prefetch("presalesProfile", {
  progress: "正在读取客户画像和产品目录",
  description: "读取售前咨询所需的客户画像、存量关系和产品目录；这是只读上下文，失败的可选关系数据不阻塞咨询推进。",
  when: () => true,
  cacheKey: (_state, _context, { session }) => session.userId,
  run: (_state, context, { session }) => ({
    customer: context.call("connectors.presales.getCustomerProfile", { userId: session.userId }),
    relationships: context.call("connectors.presales.getExistingRelationships", { userId: session.userId }),
    productCatalog: context.call("connectors.presales.getProductCatalog", {}),
  }),
});

derive("recommendProducts", {
  progress: "正在匹配可咨询产品",
  description: "在金额和用途齐备后调用产品匹配工具，候选产品通过 tool message 暴露给 render，不作为长期业务 state。",
  when: (state, context) => {
    const facts = presalesFacts(context);
    const need = financingNeed(state);
    return Boolean(
      state.status !== "cancelled" &&
      facts.customer &&
      facts.productCatalog &&
      need &&
      context.get("recommendProducts:cacheKey") !== productMatchCacheKey(facts.customer.id, need),
    );
  },
  run: async (state, context) => {
    const facts = presalesFacts(context);
    const need = financingNeed(state);
    if (!facts.customer || !facts.productCatalog || !need) return {};

    const matches = await context.call("connectors.presales.matchProducts", {
      customer: facts.customer,
      relationships: facts.relationships ?? null,
      products: facts.productCatalog,
      need,
    });
    context.set<ProductMatch[]>("latestProductMatches", matches);
    context.set("recommendProducts:cacheKey", productMatchCacheKey(facts.customer.id, need));

    return {
      ...(state.status === "collecting" ? { status: "recommending" as const } : {}),
      messages: [
        new ToolMessage({
          name: "connectors.presales.matchProducts",
          call: {
            customerId: facts.customer.id,
            requestedAmountCents: need.requestedAmountCents,
            useCase: need.useCase,
            termMonths: need.termMonths,
          },
          result: matches,
        }),
      ],
    };
  },
});

derive("selectedProductDetails", {
  progress: "正在读取产品说明",
  description: "用户明确选择产品后读取产品详情、材料和费用口径；该步骤只读，不创建线索或审批记录。",
  when: (state, context) =>
    Boolean(
      state.status !== "cancelled" &&
      state.selectedProduct &&
      context.get("selectedProductDetails:productId") !== state.selectedProduct.id,
    ),
  run: async (state, context) => {
    if (!state.selectedProduct) return {};
    const details = await context.call("connectors.presales.getProductDetails", {
      productId: state.selectedProduct.id,
    });
    context.set("selectedProductDetails:productId", state.selectedProduct.id);

    return {
      messages: [
        new ToolMessage({
          name: "connectors.presales.getProductDetails",
          call: { productId: state.selectedProduct.id },
          result: details,
        }),
      ],
    };
  },
});

derive("indicativeRepayment", {
  progress: "正在进行售前试算",
  description: "产品、金额和期限齐备后生成非绑定还款估算；估算仅供售前咨询，不代表授信或定价承诺。",
  when: (state, context) => {
    const facts = presalesFacts(context);
    const need = financingNeed(state);
    return Boolean(
      state.status !== "cancelled" &&
      facts.customer &&
      state.selectedProduct &&
      need?.termMonths &&
      context.get("indicativeRepayment:cacheKey") !== repaymentCacheKey(state.selectedProduct, need),
    );
  },
  run: async (state, context) => {
    const facts = presalesFacts(context);
    const need = financingNeed(state);
    if (!facts.customer || !state.selectedProduct || !need?.termMonths) return {};

    const estimate = await context.call("connectors.presales.calculateIndicativeRepayment", {
      customer: facts.customer,
      relationships: facts.relationships ?? null,
      product: state.selectedProduct,
      amountCents: need.requestedAmountCents,
      termMonths: need.termMonths,
    });
    context.set("indicativeRepayment:cacheKey", repaymentCacheKey(state.selectedProduct, need));

    return {
      messages: [
        new ToolMessage({
          name: "connectors.presales.calculateIndicativeRepayment",
          call: {
            productId: state.selectedProduct.id,
            amountCents: need.requestedAmountCents,
            termMonths: need.termMonths,
          },
          result: estimate,
        }),
      ],
    };
  },
});

command("createConsultationLead", {
  progress: "正在创建销售跟进线索",
  description: "只有用户明确要求顾问跟进且产品、金额和用途齐备时才写入外部销售线索；这是本流程唯一外部写操作。",
  when: (state) =>
    state.status === "lead_requested" &&
    Boolean(state.selectedProduct && state.requestedAmountCents && state.useCase && !state.lead),
  run: async (state, context) => {
    const facts = presalesFacts(context);
    const need = financingNeed(state);
    if (!facts.customer || !state.selectedProduct || !need) return {};

    const lead = await context.call("connectors.presales.createConsultationLead", {
      customer: facts.customer,
      product: state.selectedProduct,
      need,
    });

    return {
      lead,
      status: "lead_created",
      messages: [
        new ToolMessage({
          name: "connectors.presales.createConsultationLead",
          call: {
            customerId: facts.customer.id,
            productId: state.selectedProduct.id,
            requestedAmountCents: need.requestedAmountCents,
            useCase: need.useCase,
          },
          result: lead,
        }),
      ],
    };
  },
});

export default render({
  name: "presales_consultation_reply",
  progress: "正在生成售前咨询回复",
  instruction: `
Write the next concise Chinese reply for a financial presales consultation assistant.

Reply rules:
1. If the user cancelled, say the current consultation has stopped and do not continue recommending or arranging follow-up.
2. If the latest tool result is connectors.presales.createConsultationLead, report that a sales follow-up lead has been created and name the assigned advisor if available. Do not say the loan is approved.
3. If the latest tool result is connectors.presales.calculateIndicativeRepayment, explain the estimated monthly payment and total repayment as non-binding presales estimates.
4. If the latest tool result is connectors.presales.getProductDetails, answer product detail, documents, fees, or eligibility questions from that tool result.
5. If the latest tool result is connectors.presales.matchProducts, summarize recommended and not-eligible products separately, explain key reasons or gaps, and ask which product or detail the user wants next.
6. If amount or use case is missing, ask only for the missing financing amount or business purpose.
7. If the user asks for a sales advisor but product, amount, or use case is missing, ask for the missing prerequisite instead of creating a lead.
8. Always state that recommendations, rates, fees, and repayment estimates are preliminary and final results depend on formal review and contract terms.

Do not collect sensitive documents in chat. Do not promise approval, guaranteed rates, guaranteed额度, or final terms. Do not output JSON, internal state names, or workflow terms.
  `,
});

/**
 * Reads typed presales facts from runtime context.
 * Input: workflow runtime context populated by prefetch.
 * Output: partial facts because prefetch failures can omit individual keys.
 * Boundary: this helper never fabricates missing customer, relationship, or product data.
 */
function presalesFacts(context: PresalesContext): Partial<PresalesFacts> {
  const facts: Partial<PresalesFacts> = {};
  const customer = context.get<CustomerProfile>("customer");
  const relationships = context.get<ExistingRelationships | null>("relationships");
  const productCatalog = context.get<PresalesProduct[]>("productCatalog");

  if (customer !== undefined) facts.customer = customer;
  if (relationships !== undefined) facts.relationships = relationships;
  if (productCatalog !== undefined) facts.productCatalog = productCatalog;

  return facts;
}

/**
 * Builds the minimum normalized financing need required by presales matching.
 * Input: durable workflow state.
 * Output: financing need when amount and use case are present.
 * Boundary: term remains optional because the procedure allows recommendation without it.
 */
function financingNeed(state: PresalesState): FinancingNeed | undefined {
  if (!state.requestedAmountCents || !state.useCase) return undefined;
  return {
    requestedAmountCents: state.requestedAmountCents,
    useCase: state.useCase,
    termMonths: state.termMonths,
  };
}

/**
 * Creates a stable cache key for product matching.
 * Input: customer id and normalized financing need.
 * Output: string key used in runtime context.
 * Boundary: cache only suppresses duplicate read calls in one workflow session.
 */
function productMatchCacheKey(customerId: string, need: FinancingNeed): string {
  return `${customerId}:${need.requestedAmountCents}:${need.useCase}:${need.termMonths ?? "none"}`;
}

/**
 * Creates a stable cache key for repayment estimates.
 * Input: selected product and normalized financing need.
 * Output: string key used in runtime context.
 * Boundary: cache only suppresses duplicate estimates for unchanged input.
 */
function repaymentCacheKey(product: PresalesProduct, need: FinancingNeed): string {
  return `${product.id}:${need.requestedAmountCents}:${need.termMonths ?? "none"}`;
}
