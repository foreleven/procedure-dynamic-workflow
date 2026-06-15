import { defineConnectorCatalog, defineConnectorRef, defineConnectorTool, z } from "@pac/workflow";
import {
  mockExistingRelationships,
  mockPresalesCustomers,
  mockPresalesProducts,
} from "../mockData.js";

export const RiskTierSchema = z.enum(["low", "medium", "high"]);
export const UseCaseSchema = z.enum([
  "working_capital",
  "inventory",
  "equipment",
  "expansion",
  "invoice_bridge",
]);

export const CustomerProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  businessName: z.string(),
  customerType: z.enum(["sme", "individual"]),
  city: z.string(),
  industry: z.string(),
  businessAgeMonths: z.number().int().nonnegative(),
  annualRevenueCents: z.number().int().nonnegative(),
  riskTier: RiskTierSchema,
  phone: z.string(),
  email: z.string(),
  contactPermission: z.boolean(),
});

export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;

export const ExistingRelationshipsSchema = z.object({
  userId: z.string(),
  businessChecking: z.boolean(),
  merchantServices: z.boolean(),
  existingLoanBalanceCents: z.number().int().nonnegative(),
  priorDelinquencies: z.number().int().nonnegative(),
  relationshipMonths: z.number().int().nonnegative(),
});

export type ExistingRelationships = z.infer<typeof ExistingRelationshipsSchema>;

export const ProductCategorySchema = z.enum(["credit_line", "term_loan", "equipment_finance"]);

export const AprRangeSchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
});

export const PresalesProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: ProductCategorySchema,
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

export type PresalesProduct = z.infer<typeof PresalesProductSchema>;

export const FinancingNeedSchema = z.object({
  requestedAmountCents: z.number().int().positive(),
  useCase: UseCaseSchema,
  termMonths: z.number().int().positive().nullable(),
});

export type FinancingNeed = z.infer<typeof FinancingNeedSchema>;

export const ProductMatchSchema = z.object({
  product: PresalesProductSchema,
  fit: z.enum(["recommended", "possible", "not_eligible"]),
  reasons: z.array(z.string()),
  gaps: z.array(z.string()),
});

export type ProductMatch = z.infer<typeof ProductMatchSchema>;

export const ProductDetailsSchema = z.object({
  product: PresalesProductSchema,
  documents: z.array(z.string()),
  fees: z.array(z.string()),
  complianceNote: z.string(),
});

export type ProductDetails = z.infer<typeof ProductDetailsSchema>;

export const RepaymentEstimateSchema = z.object({
  productId: z.string(),
  amountCents: z.number().int().positive(),
  termMonths: z.number().int().positive(),
  aprBps: z.number().int().positive(),
  estimatedMonthlyPaymentCents: z.number().int().positive(),
  estimatedTotalRepaymentCents: z.number().int().positive(),
  caveat: z.string(),
});

export type RepaymentEstimate = z.infer<typeof RepaymentEstimateSchema>;

export const ConsultationLeadSchema = z.object({
  id: z.string(),
  status: z.enum(["created"]),
  customerId: z.string(),
  productId: z.string(),
  requestedAmountCents: z.number().int().positive(),
  useCase: UseCaseSchema,
  assignedAdvisorName: z.string(),
  createdAt: z.string(),
});

export type ConsultationLead = z.infer<typeof ConsultationLeadSchema>;

export const UserIdInputSchema = z.object({
  userId: z.string(),
});

export const ProductIdInputSchema = z.object({
  productId: z.string(),
});

export const MatchProductsInputSchema = z.object({
  customer: CustomerProfileSchema,
  relationships: ExistingRelationshipsSchema.nullable(),
  products: z.array(PresalesProductSchema),
  need: FinancingNeedSchema,
});

export const CalculateRepaymentInputSchema = z.object({
  customer: CustomerProfileSchema,
  relationships: ExistingRelationshipsSchema.nullable(),
  product: PresalesProductSchema,
  amountCents: z.number().int().positive(),
  termMonths: z.number().int().positive(),
});

export const CreateConsultationLeadInputSchema = z.object({
  customer: CustomerProfileSchema,
  product: PresalesProductSchema,
  need: FinancingNeedSchema,
});

export const getCustomerProfileConnector = defineConnectorRef({
  id: "connectors.presales.getCustomerProfile",
  description: "Read the customer profile used as presales consultation context.",
  inputSchema: UserIdInputSchema,
  outputSchema: CustomerProfileSchema,
});

export const getExistingRelationshipsConnector = defineConnectorRef({
  id: "connectors.presales.getExistingRelationships",
  description: "Read the customer's current banking relationship summary.",
  inputSchema: UserIdInputSchema,
  outputSchema: ExistingRelationshipsSchema.nullable(),
});

export const getProductCatalogConnector = defineConnectorRef({
  id: "connectors.presales.getProductCatalog",
  description: "Read the current presales product catalog.",
  inputSchema: z.object({}),
  outputSchema: z.array(PresalesProductSchema),
});

export const matchProductsConnector = defineConnectorRef({
  id: "connectors.presales.matchProducts",
  description: "Match available products to the customer's stated financing need.",
  inputSchema: MatchProductsInputSchema,
  outputSchema: z.array(ProductMatchSchema),
});

export const getProductDetailsConnector = defineConnectorRef({
  id: "connectors.presales.getProductDetails",
  description: "Read detailed presales information for one product.",
  inputSchema: ProductIdInputSchema,
  outputSchema: ProductDetailsSchema,
});

export const calculateIndicativeRepaymentConnector = defineConnectorRef({
  id: "connectors.presales.calculateIndicativeRepayment",
  description: "Calculate a non-binding repayment estimate for presales consultation.",
  inputSchema: CalculateRepaymentInputSchema,
  outputSchema: RepaymentEstimateSchema,
});

export const createConsultationLeadConnector = defineConnectorRef({
  id: "connectors.presales.createConsultationLead",
  description: "Create a sales follow-up lead after explicit customer consent.",
  inputSchema: CreateConsultationLeadInputSchema,
  outputSchema: ConsultationLeadSchema,
});

export const presalesConnectorCatalog = defineConnectorCatalog({
  "connectors.presales.getCustomerProfile": getCustomerProfileConnector,
  "connectors.presales.getExistingRelationships": getExistingRelationshipsConnector,
  "connectors.presales.getProductCatalog": getProductCatalogConnector,
  "connectors.presales.matchProducts": matchProductsConnector,
  "connectors.presales.getProductDetails": getProductDetailsConnector,
  "connectors.presales.calculateIndicativeRepayment": calculateIndicativeRepaymentConnector,
  "connectors.presales.createConsultationLead": createConsultationLeadConnector,
});

export type PresalesConnectorCatalog = typeof presalesConnectorCatalog;

/**
 * Reads a mock customer profile by user id.
 * Input: authenticated workflow user id.
 * Output: schema-valid customer profile.
 * Boundary: this is read-only fixture data for presales context, not credit approval.
 */
export async function getCustomerProfile(userId: string): Promise<CustomerProfile> {
  const profile = mockPresalesCustomers[userId as keyof typeof mockPresalesCustomers];
  return CustomerProfileSchema.parse(profile ?? {
    id: userId,
    name: "Guest User",
    businessName: "Guest Business",
    customerType: "sme",
    city: "Jersey City",
    industry: "unknown",
    businessAgeMonths: 0,
    annualRevenueCents: 0,
    riskTier: "medium",
    phone: "+1-201-555-0100",
    email: `${safeEmailLocalPart(userId)}@example.com`,
    contactPermission: false,
  });
}

/**
 * Reads the customer's existing banking relationship summary.
 * Input: authenticated workflow user id.
 * Output: relationship facts or null when there is no prior relationship.
 * Boundary: failures are handled by prefetch isolation in the runtime.
 */
export async function getExistingRelationships(userId: string): Promise<ExistingRelationships | null> {
  const relationship = mockExistingRelationships[userId as keyof typeof mockExistingRelationships];
  return relationship ? ExistingRelationshipsSchema.parse(relationship) : null;
}

/**
 * Returns the active mock product catalog.
 * Input: none.
 * Output: all configured presales products.
 * Boundary: this is a read-only catalog snapshot used by workflow matching.
 */
export async function getProductCatalog(): Promise<PresalesProduct[]> {
  return z.array(PresalesProductSchema).parse(mockPresalesProducts);
}

/**
 * Matches products to the stated financing need and customer context.
 * Input: customer profile, optional relationship facts, catalog, and normalized need.
 * Output: relevant products with recommendation fit, reasons, and gaps.
 * Boundary: this is presales eligibility guidance only and never represents approval.
 */
export async function matchProducts(input: z.infer<typeof MatchProductsInputSchema>): Promise<ProductMatch[]> {
  const parsed = MatchProductsInputSchema.parse(input);
  const relevantProducts = parsed.products.filter((product) => product.useCases.includes(parsed.need.useCase));
  const matches = relevantProducts
    .map((product) => matchOneProduct(parsed.customer, parsed.relationships, parsed.need, product))
    .sort((left, right) => fitRank(left.fit) - fitRank(right.fit) || left.product.minAmountCents - right.product.minAmountCents);

  return z.array(ProductMatchSchema).parse(matches);
}

/**
 * Reads detailed product notes for one product.
 * Input: product id from the current product catalog.
 * Output: product details, required documents, fees, and compliance note.
 * Boundary: throws when product id is unknown because workflow state should only contain visible choices.
 */
export async function getProductDetails(input: { productId: string }): Promise<ProductDetails> {
  const product = await requireProduct(input.productId);
  return ProductDetailsSchema.parse({
    product,
    documents: product.requiredDocuments,
    fees: product.fees,
    complianceNote: "售前信息仅供初步了解，最终额度、利率、费用和审批结果以正式审核及合同为准。",
  });
}

/**
 * Calculates a non-binding repayment estimate for a selected product.
 * Input: customer context, selected product, amount, and term.
 * Output: monthly and total repayment estimate with a compliance caveat.
 * Boundary: this does not perform pricing approval or reserve an offer.
 */
export async function calculateIndicativeRepayment(
  input: z.infer<typeof CalculateRepaymentInputSchema>,
): Promise<RepaymentEstimate> {
  const parsed = CalculateRepaymentInputSchema.parse(input);
  const aprBps = indicativeAprBps(parsed.product, parsed.relationships);
  const monthlyRate = aprBps / 10000 / 12;
  const principal = parsed.amountCents;
  const payment =
    monthlyRate === 0
      ? principal / parsed.termMonths
      : principal * (monthlyRate / (1 - (1 + monthlyRate) ** -parsed.termMonths));

  return RepaymentEstimateSchema.parse({
    productId: parsed.product.id,
    amountCents: parsed.amountCents,
    termMonths: parsed.termMonths,
    aprBps,
    estimatedMonthlyPaymentCents: Math.round(payment),
    estimatedTotalRepaymentCents: Math.round(payment * parsed.termMonths),
    caveat: "这是售前估算，不构成授信承诺；实际利率、费用和还款计划以正式审批和合同为准。",
  });
}

/**
 * Creates a deterministic sales consultation lead after explicit user consent.
 * Input: customer profile, selected product, and current financing need.
 * Output: external lead record returned to workflow state.
 * Boundary: this is the only externally mutating connector in this scenario.
 */
export async function createConsultationLead(
  input: z.infer<typeof CreateConsultationLeadInputSchema>,
): Promise<ConsultationLead> {
  const parsed = CreateConsultationLeadInputSchema.parse(input);
  const advisor = parsed.customer.city === "Newark" ? "Maya Patel" : "Alex Rivera";
  return ConsultationLeadSchema.parse({
    id: `lead_${parsed.customer.id}_${parsed.product.id}_${parsed.need.requestedAmountCents}`,
    status: "created",
    customerId: parsed.customer.id,
    productId: parsed.product.id,
    requestedAmountCents: parsed.need.requestedAmountCents,
    useCase: parsed.need.useCase,
    assignedAdvisorName: advisor,
    createdAt: "2026-06-13T10:00:00+08:00",
  });
}

export const presalesConnectorTools = [
  defineConnectorTool(getCustomerProfileConnector, ({ userId }) => getCustomerProfile(userId)),
  defineConnectorTool(getExistingRelationshipsConnector, ({ userId }) => getExistingRelationships(userId)),
  defineConnectorTool(getProductCatalogConnector, () => getProductCatalog()),
  defineConnectorTool(matchProductsConnector, matchProducts),
  defineConnectorTool(getProductDetailsConnector, getProductDetails),
  defineConnectorTool(calculateIndicativeRepaymentConnector, calculateIndicativeRepayment),
  defineConnectorTool(createConsultationLeadConnector, createConsultationLead),
];

/**
 * Provides the presales connector tools for engine-owned registry construction.
 * Input: none.
 * Output: deterministic mock connector tools for this agent.
 * Boundary: the engine owns ConnectorRegistry creation and duplicate-id validation across files.
 */
export default function loadPresalesConnectorTools() {
  return presalesConnectorTools;
}

/**
 * Scores one product against a customer and financing need.
 * Input: normalized customer facts, relationship facts, need, and product.
 * Output: a product match with reasons and gaps.
 * Boundary: this is deterministic fixture logic for tests, not a credit policy engine.
 */
function matchOneProduct(
  customer: CustomerProfile,
  relationships: ExistingRelationships | null,
  need: FinancingNeed,
  product: PresalesProduct,
): ProductMatch {
  const gaps: string[] = [];
  const reasons = [
    `${product.name} 支持${useCaseLabel(need.useCase)}用途。`,
    `产品金额范围为 ${money(product.minAmountCents)}-${money(product.maxAmountCents)}。`,
  ];

  if (need.requestedAmountCents < product.minAmountCents) {
    gaps.push(`申请金额低于 ${product.name} 最低金额 ${money(product.minAmountCents)}。`);
  }
  if (need.requestedAmountCents > product.maxAmountCents) {
    gaps.push(`申请金额高于 ${product.name} 最高金额 ${money(product.maxAmountCents)}。`);
  }
  if (need.termMonths !== null && (need.termMonths < product.minTermMonths || need.termMonths > product.maxTermMonths)) {
    gaps.push(`期望期限不在 ${product.minTermMonths}-${product.maxTermMonths} 个月范围内。`);
  }
  if (customer.businessAgeMonths < product.minBusinessAgeMonths) {
    gaps.push(`企业经营时间少于 ${product.minBusinessAgeMonths} 个月。`);
  }
  if (customer.annualRevenueCents < product.minAnnualRevenueCents) {
    gaps.push(`年流水低于 ${money(product.minAnnualRevenueCents)} 的参考门槛。`);
  }
  if (customer.riskTier === "high" || (relationships?.priorDelinquencies ?? 0) > 1) {
    gaps.push("当前风险或逾期记录需要人工复核。");
  }

  if (relationships?.businessChecking) {
    reasons.push("客户已有企业账户关系，售前资料核验路径更清晰。");
  }

  return {
    product,
    fit: gaps.length === 0 ? "recommended" : "not_eligible",
    reasons,
    gaps,
  };
}

/**
 * Orders better product matches before weaker matches.
 * Input: product fit label.
 * Output: numeric sort rank.
 * Boundary: only affects deterministic fixture ordering, not eligibility itself.
 */
function fitRank(fit: ProductMatch["fit"]): number {
  if (fit === "recommended") return 0;
  if (fit === "possible") return 1;
  return 2;
}

/**
 * Reads one product from the mock catalog.
 * Input: product id.
 * Output: schema-valid product.
 * Boundary: throws on missing ids to expose invalid workflow state or test data.
 */
async function requireProduct(productId: string): Promise<PresalesProduct> {
  const product = (await getProductCatalog()).find((item) => item.id === productId);
  if (!product) {
    throw new Error(`Unknown presales product: ${productId}`);
  }

  return product;
}

/**
 * Chooses a deterministic indicative APR inside the product range.
 * Input: product and relationship facts.
 * Output: APR in basis points.
 * Boundary: fixture-only estimate, not pricing approval.
 */
function indicativeAprBps(product: PresalesProduct, relationships: ExistingRelationships | null): number {
  const relationshipDiscount = relationships?.businessChecking ? 75 : 0;
  return Math.max(product.aprRangeBps.min, product.aprRangeBps.min + 125 - relationshipDiscount);
}

/**
 * Converts a normalized use case into user-facing Chinese.
 * Input: use-case enum.
 * Output: display label.
 * Boundary: used only in fixture reasons.
 */
function useCaseLabel(useCase: z.infer<typeof UseCaseSchema>): string {
  const labels: Record<z.infer<typeof UseCaseSchema>, string> = {
    working_capital: "经营周转",
    inventory: "进货备货",
    equipment: "设备采购",
    expansion: "扩张装修",
    invoice_bridge: "发票回款",
  };
  return labels[useCase];
}

/**
 * Formats cents as a compact USD display string.
 * Input: amount in cents.
 * Output: formatted dollar amount.
 * Boundary: display helper for mock connector explanations.
 */
function money(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * Builds a safe mock email local part.
 * Input: arbitrary user id.
 * Output: lower-case local-part-like string.
 * Boundary: fixture fallback only.
 */
function safeEmailLocalPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, ".");
}
