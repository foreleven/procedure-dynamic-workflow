import {
  ToolMessage,
  type ConnectorId,
  type ConnectorInput,
  type ConnectorOutput,
  type WorkflowContext,
  type WorkflowToolMessage,
  workflow,
  z,
} from "@pac/workflow";
import type { OpenWebIntelligenceConnectorCatalog } from "../connectors/main.js";

const ResearchStatusSchema = z.enum([
  "collecting",
  "researching",
  "ready",
  "cancelled",
]);
const BlockerSchema = z.enum([
  "missing_research_object",
  "evidence_unavailable",
]);
const ReferenceSourceTypeSchema = z.enum([
  "official",
  "news",
  "report",
  "review",
  "directory",
  "community",
  "other",
]);
const ReferenceEvidenceKindSchema = z.enum([
  "search_result",
  "extracted_page",
]);
const ReferenceSchema = z.object({
  id: z.string().regex(/^R\d+$/),
  title: z.string().min(1),
  url: z.string().url(),
  sourceType: ReferenceSourceTypeSchema,
  evidenceKind: ReferenceEvidenceKindSchema,
  date: z.string().nullable(),
});

const ResearchStateSchema = z.object({
  status: ResearchStatusSchema,
  researchQuestion: z.array(z.string().min(1)),
  references: z.array(ReferenceSchema),
  blocker: BlockerSchema.nullable(),
});

export type ResearchState = z.infer<typeof ResearchStateSchema>;

type WebContext = WorkflowContext<OpenWebIntelligenceConnectorCatalog>;
type WebConnectorId = ConnectorId<OpenWebIntelligenceConnectorCatalog>;
type SearchConnector =
  OpenWebIntelligenceConnectorCatalog["connectors.web.search"];
type ExtractConnector =
  OpenWebIntelligenceConnectorCatalog["connectors.web.extractPages"];
type SearchInput = ConnectorInput<SearchConnector>;
type SearchOutput = ConnectorOutput<SearchConnector>;
type SearchResult = SearchOutput["results"][number];
type ExtractInput = ConnectorInput<ExtractConnector>;
type ExtractOutput = ConnectorOutput<ExtractConnector>;
type ExtractResult = ExtractOutput["results"][number];
type SearchTopic = NonNullable<SearchInput["topic"]>;
type SearchTimeRange = NonNullable<SearchInput["timeRange"]>;
type Reference = z.infer<typeof ReferenceSchema>;

const SearchActionSchema = z.object({
  kind: z.literal("search"),
  label: z.string().min(1),
  query: z.string().min(1),
  topic: z.enum(["general", "news", "finance"]).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  includeDomains: z.array(z.string().min(1)).max(8).optional(),
  reason: z.string().min(1),
});
const ExtractActionSchema = z.object({
  kind: z.literal("extract"),
  label: z.string().min(1),
  urls: z.array(z.string().url()).min(1).max(8),
  query: z.string().min(1).optional(),
  reason: z.string().min(1),
});
const ResearchActionSchema = z.discriminatedUnion("kind", [
  SearchActionSchema,
  ExtractActionSchema,
]);
const ReferenceHintSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  sourceType: ReferenceSourceTypeSchema,
  evidenceKind: ReferenceEvidenceKindSchema,
  date: z.string().nullable(),
});
const ResearchPassStateSchema = z.object({
  passGoal: z.string().min(1),
  actions: z.array(ResearchActionSchema).min(1).max(8),
  referenceHints: z.array(ReferenceHintSchema).max(12).optional(),
});

type ResearchPassState = z.infer<typeof ResearchPassStateSchema>;
type SearchAction = z.infer<typeof SearchActionSchema>;
type ExtractAction = z.infer<typeof ExtractActionSchema>;
type ReferenceHint = z.infer<typeof ReferenceHintSchema>;
type ReferenceDraft = Omit<Reference, "id">;

const MaxReferences = 24;

const initialState = ResearchStateSchema.parse({
  status: "collecting",
  researchQuestion: [],
  references: [],
  blocker: null,
});

const invalidation = {
  researchQuestion: ["blocker", "references"],
} satisfies Partial<Record<keyof ResearchState & string, Array<keyof ResearchState & string>>>;

const { patch, effect, loop, render } = workflow<
  ResearchState,
  OpenWebIntelligenceConnectorCatalog
>({
  stateSchema: ResearchStateSchema,
  state: initialState,
  invalidation,
});

patch({
  progress: "正在理解调研问题",
  state: {
    status: ResearchStatusSchema.describe("Set cancelled only for explicit cancellation. Set researching when the latest user message provides, changes, or extends a concrete research request. Set collecting when the latest user message asks for research but does not name any company, product, website, market, industry, competitor list, or concrete question. Do not set ready."),
    researchQuestion: z.array(z.string().min(1)).max(8).describe("The complete durable research agenda as one or more user-facing research questions. For a single request, output one concise self-contained question. For multi-part research, output multiple durable sub-questions such as competitor discovery, pricing comparison, market trend scan, or official website signal review. Keep user-stated object, purpose, competitors, website/domain, region, language, time range, and output style inside the relevant questions. These are not rewritten search queries."),
  },
  invalidates: invalidation,
  instruction: `
Extract only durable user-expressed research intent from the latest user message.
Do not reply to the user. Do not call connectors. Do not invent competitors, websites, facts, prices, market sizes, users, revenue, funding, customer names, product capabilities, queries, sources, or references.

State is intentionally minimal:
- researchQuestion is an array of durable user-facing research questions, not connector queries and not an analysis plan.
- For a simple request, use one self-contained question.
- For a multi-part request, split only durable sub-questions the user would recognize, such as "identify direct competitors" and "compare the market situation of the head competitors".
- Include explicit company/product/site/market/question, purpose, named competitors, region, language, time sensitivity, and requested output style inside the relevant researchQuestion items when the user says them.
- If the user says latest/today/current/this week/recent, keep that wording in the relevant question. Do not normalize into a separate field.
- If the user gives a concrete website or domain, keep it in the relevant question.
- If the latest message changes the research object, purpose, competitors, website, region, time range, or output style, replace researchQuestion with the new complete agenda.
- If the latest message extends the current research with a follow-up sub-question, output the full updated agenda, not only the new delta.
- Current state may be used only to resolve follow-up references such as "same scope", "those companies", or "change it to Europe" into a complete updated researchQuestion array.
- If the latest message starts a new research request but lacks any concrete object or question and cannot be resolved from current state, set researchQuestion to an empty array.
- Leave researchQuestion unchanged when the latest message is a follow-up that does not change or extend research scope.
- Never write references in patch. References come only from connector-backed loop effects.
- Omit researchQuestion rather than setting it to null when no concrete research object or question is present.

Status:
- Set status to cancelled only for explicit cancellation or stopping this research.
- Set status to researching when a concrete researchQuestion agenda is provided, changed, or extended.
- Set status to collecting when the user requests research but omits the concrete research object or question.
- Do not set status to ready.
`,
});

effect("resolveReadiness", [
  "status",
  "researchQuestion",
], {
  description: "Reads the minimal durable research agenda and returns lifecycle readiness; it does not call connectors or create external side effects.",
  run: (state) => {
    if (state.status === "cancelled" || state.status === "ready") return {};

    if (!hasResearchAgenda(state)) {
      return {
        status: "collecting" as const,
        blocker: "missing_research_object" as const,
      };
    }

    return {
      status: "researching" as const,
      blocker: null,
    };
  },
});

const researchLoop = loop("researchPasses", {
  description: "Runs bounded multi-pass public-source research for the current agenda; loop state owns per-pass actions while durable state keeps only compact source references.",
  dependsOn: ["researchQuestion"],
  maxRuns: 3,
  stateSchema: ResearchPassStateSchema,
  instruction: `
Plan the next bounded public web research pass for the current workflow state.

Decision policy:
- If state.status is cancelled, collecting, or researchQuestion is empty, return blocked with state null.
- If prior tool evidence and state.references are already enough to answer the current researchQuestion agenda at the requested granularity, return satisfied with state null.
- If more evidence is needed and a useful bounded action remains, return continue with a ResearchPassState.
- If continuing would only repeat low-value searches, irrelevant sources, inaccessible pages, or ambiguous scope, return blocked with state null and explain the gap.

How to rewrite queries:
- Cover object, semantic category, competitor/alternative language, evidence type, time, geography, and source authority.
- Prefer 3 to 6 complementary search actions in the first pass.
- Use broad discovery queries for candidates, then narrower queries for pricing, features, customers, docs, case studies, press, funding, launch, reports, reviews, and recent news.
- For latest/current/recent questions, use topic "news" or an explicit timeRange.
- If the user provided a domain, include at least one domain-limited official-page query with includeDomains.
- Do not output one vague query that merely repeats the user message.

How to decide extraction:
- Search results are only candidate sources.
- Use later passes to inspect search ToolMessages and choose high-value URLs for extract actions.
- Choose extraction URLs with model judgment: official/primary sources first, then dated reputable reports/news/reviews, with domain diversity.
- Extract pages before treating prices, plans, product capability, customers, dates, funding, market size, regulatory claims, or direct-competitor classification as supported facts.
- Keep each extract action to the smallest useful URL set, normally 3 to 8 URLs.

Loop state rules:
- passGoal is the concrete purpose of this pass.
- actions contains only search and extract actions for this pass.
- referenceHints contains compact citation metadata only for URLs that appear in prior tool evidence or in extract actions selected from prior search evidence. Do not invent URLs.
- Use sourceType to classify source provenance, not business importance.
- Use evidenceKind "extracted_page" only when the page has been extracted or is being extracted in this pass; otherwise use "search_result".
- Generated queries, source rankings, page bodies, and long summaries do not belong in workflow state.

Stop when enough:
- Enough means evidence supports the current answer granularity, not that every possible source has been searched.
- Continue only when the next pass can materially improve evidence quality or close a named gap.
- It is acceptable to stop with partial evidence if the remaining gap is stated clearly.
`,
});

researchLoop.effect("runSearchActions", ["loop.state"], {
  description: "Executes model-planned read-only search actions for the current pass and keeps search payloads as render-visible tool evidence.",
  run: async (_state, context, runtime, step) => {
    const actions = runtime.loop.state.actions.filter(isSearchAction);
    if (actions.length === 0) return {};

    const loading = step.start("搜索候选来源", {
      run: runtime.loop.run,
      queryCount: actions.length,
    });
    const searches = await Promise.all(
      actions.map((action) =>
        call(context, "connectors.web.search", toSearchInput(action)),
      ),
    );
    loading.end({
      succeeded: searches.filter((entry) => entry.result !== null).length,
      failed: searches.filter((entry) => entry.result === null).length,
    });

    return {
      messages: searches.map((entry) => entry.message),
    };
  },
});

researchLoop.effect("runExtractionActions", ["runSearchActions"], {
  description: "Executes model-selected page extraction actions for the current pass; extracted page bodies stay in tool messages while citation handles are patched separately.",
  run: async (_state, context, runtime, step) => {
    const actions = runtime.loop.state.actions.filter(isExtractAction);
    if (actions.length === 0) return {};

    const extractionInputs = actions
      .map((action) => toExtractInput(action, runtime.loop.state.passGoal))
      .filter((input): input is ExtractInput => input !== null);
    if (extractionInputs.length === 0) return {};

    const loading = step.start("抽取高价值页面", {
      run: runtime.loop.run,
      urlCount: extractionInputs.reduce((count, input) => count + input.urls.length, 0),
    });
    const extractions = await Promise.all(
      extractionInputs.map((input) =>
        call(context, "connectors.web.extractPages", input),
      ),
    );
    loading.end({
      extracted: extractions.reduce(
        (count, entry) => count + (entry.result?.results.length ?? 0),
        0,
      ),
      failed: extractions.reduce(
        (count, entry) => count + (entry.result?.failedResults.length ?? 0),
        0,
      ),
    });

    return {
      messages: extractions.map((entry) => entry.message),
    };
  },
});

researchLoop.effect("storeReferences", ["runExtractionActions"], {
  description: "Merges only compact connector-backed citation handles into durable state for later source markers; raw evidence remains in tool messages.",
  run: (state, _context, runtime) => {
    const references = referencesFromEvidence(
      state.references,
      runtime.loop.state.referenceHints ?? [],
      state.messages.filter(isToolMessage),
    );

    if (sameReferences(state.references, references)) return {};
    return { references };
  },
});

effect("markResearchReady", ["loop.researchPasses"], {
  description: "Marks bounded research ready after the loop stops, using compact references and connector evidence to decide whether render can summarize or should explain evidence gaps.",
  run: (state) => {
    if (state.status !== "researching" || !hasResearchAgenda(state)) {
      return {};
    }

    const hasEvidence =
      state.references.length > 0 ||
      hasConnectorEvidence(state.messages.filter(isToolMessage));

    return {
      status: "ready" as const,
      blocker: hasEvidence ? null : "evidence_unavailable" as const,
    };
  },
});

export default render({
  name: "competitor_market_research_reply",
  progress: "正在生成调研回复",
  instruction: `
Write the next professional Chinese reply for a competitor and market research assistant.

Use current state as the durable request and source-reference handle list. Use tool messages as public-source evidence. Do not call connectors or mutate state in render.

Reply rules:
1. If the user cancelled, say the current public web research has stopped.
2. If the research object/question is missing, ask one compact intake message with 1 to 3 high-impact questions needed for query rewriting, such as object/topic, research purpose, and time or region scope. Do not ask for one missing field per turn when several fields are clearly needed.
3. If only purpose, region, language, timeframe, or output format is missing but the object/question is concrete enough, proceed with reasonable defaults and state those defaults instead of blocking for confirmation.
4. If evidence is unavailable or connector messages are errors, say what was unavailable and propose the next query direction, such as a more specific product, website, region, competitor list, or source type. If follow-up input is needed, group up to 3 concrete questions in one message.
5. If evidence is available, summarize using this structure: research scope, key findings, evidence/source notes, uncertainty, and next verification steps.
6. Use state.references as the citation handle list. Put compact source markers like [R1] beside important factual claims when a matching reference supports the claim. At the end, include a short source list for the cited reference ids with title, source type, date when available, and URL.
7. Prefer references whose evidenceKind is extracted_page for important claims. Treat search_result references as candidate-source support only, and label weak conclusions accordingly.
8. Explain the query strategy at a business level when useful, such as broad discovery, official evidence pages, recent signals, or domain-limited official pages. Do not expose connector syntax, JSON, state names, workflow terms, loop names, or tool-call markup.
9. Treat search results as candidate sources. Treat extracted page content as stronger evidence. Never treat search rank as proof of market position.
10. Down-rank unsupported claims: use "公开资料显示" only for extracted or clearly source-supported facts, "基于这些来源可初步判断" for analysis, and "仍需验证" for weak or missing evidence.
11. For competitor discovery, separate direct competitors, indirect competitors, substitutes, and adjacent players when the evidence supports that distinction.
12. For pricing and positioning, do not fill missing prices or packages. Mark unavailable, sales-contact-only, region-dependent, or unconfirmed prices clearly.
13. For market trends, state the timeframe implied by the available sources and avoid treating stale material as current.
14. For website analysis, say it is based on public pages discovered through search and extracted selectively; do not claim full-site crawling or exhaustive site traversal.
15. For deep report requests, explain that this workflow uses bounded public search and selected page extraction; organize missing sections as evidence gaps or follow-up questions instead of filling them in.

Never fabricate market size, revenue, users, funding, pricing, customer lists, product capabilities, source dates, source URLs, citation ids, or future trends. Do not claim formal due diligence, legal review, audit, investment rating, supplier security assessment, or compliance review.
  `,
});

interface ConnectorCallResult<TId extends WebConnectorId> {
  message: ToolMessage;
  result: ConnectorOutput<OpenWebIntelligenceConnectorCatalog[TId]> | null;
}

/**
 * Calls a connector and converts connector failures into render-visible tool facts.
 * Input: connector id plus schema-valid connector input.
 * Output: parsed connector result when available and a ToolMessage for render.
 * Boundary: failures do not abort the workflow turn; render decides how to explain evidence gaps.
 */
async function call<TId extends WebConnectorId>(
  context: WebContext,
  id: TId,
  input: ConnectorInput<OpenWebIntelligenceConnectorCatalog[TId]>,
): Promise<ConnectorCallResult<TId>> {
  try {
    const result = await context.call(id, input, { cache: true });
    return {
      result,
      message: new ToolMessage({ name: id, call: input, result }),
    };
  } catch (error) {
    return {
      result: null,
      message: new ToolMessage({
        name: id,
        call: input,
        result: { error: errorMessage(error) },
        isError: true,
      }),
    };
  }
}

function hasResearchAgenda(state: ResearchState): boolean {
  return state.researchQuestion.some((question) => question.trim().length > 0);
}

function isSearchAction(action: ResearchPassState["actions"][number]): action is SearchAction {
  return action.kind === "search";
}

function isExtractAction(action: ResearchPassState["actions"][number]): action is ExtractAction {
  return action.kind === "extract";
}

function toSearchInput(action: SearchAction): SearchInput {
  const input: SearchInput = {
    query: action.query,
    searchDepth: "advanced",
    maxResults: 5,
    includeAnswer: "basic",
    includeFavicon: true,
  };

  if (action.topic) input.topic = action.topic as SearchTopic;
  if (action.timeRange) input.timeRange = action.timeRange as SearchTimeRange;
  if (action.includeDomains && action.includeDomains.length > 0) {
    input.includeDomains = action.includeDomains;
  }

  return input;
}

function toExtractInput(
  action: ExtractAction,
  fallbackQuery: string,
): ExtractInput | null {
  const urls = uniqueHttpUrls(action.urls).slice(0, 8);
  if (urls.length === 0) return null;

  return {
    urls,
    query: action.query ?? fallbackQuery,
    extractDepth: "basic",
    format: "markdown",
    includeFavicon: true,
  };
}

/**
 * Builds durable citation handles only from URLs observed in connector evidence.
 * Input: existing references, model-selected reference hints, and current tool messages.
 * Output: a compact, stable reference list capped for durable state.
 * Boundary: this never copies page bodies, search snippets, query plans, or candidate rankings into state.
 */
function referencesFromEvidence(
  existing: Reference[],
  hints: ReferenceHint[],
  messages: WorkflowToolMessage[],
): Reference[] {
  const searchResultsByUrl = searchResultIndex(messages);
  const extractedResultsByUrl = extractResultIndex(messages);
  const hintByUrl = hintIndex(hints);
  const drafts: ReferenceDraft[] = [];

  for (const [key, extracted] of extractedResultsByUrl) {
    const hint = hintByUrl.get(key);
    const searchResult = searchResultsByUrl.get(key);
    drafts.push({
      title: compactTitle(
        hint?.title ?? searchResult?.title ?? domainFromUrl(extracted.url) ?? extracted.url,
      ),
      url: extracted.url,
      sourceType: hint?.sourceType ?? "other",
      evidenceKind: "extracted_page",
      date: hint?.date ?? searchResult?.publishedDate ?? null,
    });
  }

  for (const hint of hints) {
    const key = normalizeUrlKey(hint.url);
    if (!key) continue;
    if (!searchResultsByUrl.has(key) && !extractedResultsByUrl.has(key)) continue;

    drafts.push({
      title: compactTitle(hint.title),
      url: hint.url,
      sourceType: hint.sourceType,
      evidenceKind: extractedResultsByUrl.has(key) ? "extracted_page" : hint.evidenceKind,
      date: hint.date,
    });
  }

  return mergeReferences(existing, drafts);
}

function mergeReferences(
  existing: Reference[],
  drafts: ReferenceDraft[],
): Reference[] {
  const byUrl = new Map<string, Reference>();
  for (const reference of existing) {
    const key = normalizeUrlKey(reference.url);
    if (key) byUrl.set(key, reference);
  }

  let nextId = nextReferenceId(existing);
  for (const draft of drafts) {
    const key = normalizeUrlKey(draft.url);
    if (!key) continue;

    const current = byUrl.get(key);
    if (current) {
      byUrl.set(key, preferReference(current, draft));
      continue;
    }

    byUrl.set(key, {
      id: `R${nextId}`,
      ...draft,
      title: compactTitle(draft.title),
    });
    nextId += 1;
  }

  return [...byUrl.values()].slice(0, MaxReferences);
}

function preferReference(current: Reference, draft: ReferenceDraft): Reference {
  return {
    ...current,
    title: shouldReplaceTitle(current.title, draft.title)
      ? compactTitle(draft.title)
      : current.title,
    sourceType: current.sourceType === "other" ? draft.sourceType : current.sourceType,
    evidenceKind:
      current.evidenceKind === "search_result" &&
      draft.evidenceKind === "extracted_page"
        ? "extracted_page"
        : current.evidenceKind,
    date: current.date ?? draft.date,
  };
}

function shouldReplaceTitle(current: string, next: string): boolean {
  const compactNext = compactTitle(next);
  return current === "Untitled source" || (current.length < 80 && compactNext.length > current.length);
}

function nextReferenceId(existing: Reference[]): number {
  const maxId = existing.reduce((max, reference) => {
    const match = /^R(\d+)$/.exec(reference.id);
    const id = match ? Number(match[1]) : 0;
    return Number.isFinite(id) && id > max ? id : max;
  }, 0);
  return maxId + 1;
}

function searchResultIndex(
  messages: WorkflowToolMessage[],
): Map<string, SearchResult> {
  const byUrl = new Map<string, SearchResult>();
  for (const message of messages) {
    if (message.name !== "connectors.web.search" || message.isError) continue;
    if (!isSearchOutput(message.result)) continue;

    for (const result of message.result.results) {
      const key = normalizeUrlKey(result.url);
      if (key && !byUrl.has(key)) byUrl.set(key, result);
    }
  }
  return byUrl;
}

function extractResultIndex(
  messages: WorkflowToolMessage[],
): Map<string, ExtractResult> {
  const byUrl = new Map<string, ExtractResult>();
  for (const message of messages) {
    if (message.name !== "connectors.web.extractPages" || message.isError) {
      continue;
    }
    if (!isExtractOutput(message.result)) continue;

    for (const result of message.result.results) {
      const key = normalizeUrlKey(result.url);
      if (key && !byUrl.has(key)) byUrl.set(key, result);
    }
  }
  return byUrl;
}

function hintIndex(hints: ReferenceHint[]): Map<string, ReferenceHint> {
  const byUrl = new Map<string, ReferenceHint>();
  for (const hint of hints) {
    const key = normalizeUrlKey(hint.url);
    if (key && !byUrl.has(key)) byUrl.set(key, hint);
  }
  return byUrl;
}

function hasConnectorEvidence(messages: WorkflowToolMessage[]): boolean {
  return messages.some((message) => {
    if (message.name === "connectors.web.search" && isSearchOutput(message.result)) {
      return message.result.results.length > 0;
    }
    if (
      message.name === "connectors.web.extractPages" &&
      isExtractOutput(message.result)
    ) {
      return message.result.results.length > 0;
    }
    return false;
  });
}

function sameReferences(left: Reference[], right: Reference[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSearchOutput(value: unknown): value is SearchOutput {
  return (
    isRecord(value) &&
    Array.isArray(value.results) &&
    value.results.every(isSearchResult)
  );
}

function isSearchResult(value: unknown): value is SearchResult {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.score === "number" &&
    (typeof value.publishedDate === "string" || value.publishedDate === null)
  );
}

function isExtractOutput(value: unknown): value is ExtractOutput {
  return (
    isRecord(value) &&
    Array.isArray(value.results) &&
    value.results.every(isExtractResult) &&
    Array.isArray(value.failedResults)
  );
}

function isExtractResult(value: unknown): value is ExtractResult {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.rawContent === "string"
  );
}

function isToolMessage(message: { role: string }): message is WorkflowToolMessage {
  return message.role === "tool";
}

function uniqueHttpUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    const key = normalizeUrlKey(url);
    if (!key || seen.has(key) || !isHttpUrl(url)) continue;

    seen.add(key);
    unique.push(url);
  }
  return unique;
}

function normalizeUrlKey(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

function domainFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function compactTitle(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) return "Untitled source";
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
