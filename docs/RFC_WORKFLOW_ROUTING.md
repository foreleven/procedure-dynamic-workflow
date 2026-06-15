# RFC：语义化 Workflow 路由

状态：草案
日期：2026-06-15
负责人：PAC engine maintainers
目标包：`@pac/engine`，以及未来可能扩展 metadata 的 `@pac/workflow`

## 摘要

`packages/engine/src/routing.ts` 当前使用确定性的词法匹配：先把最新用户消息转成小写，再检查 routing examples、entities 或 description 词项是否以子串形式出现在消息中，最后把命中数量映射为置信分。这个方案简单、快速、可测试，但当 workflow 数量增加、入口样例语义接近，或用户没有使用精确关键词表达需求时，会变得脆弱。

本文建议把 routing 从纯关键词匹配升级为语义化 routing，并分析两个主要方案：

- RAG / embedding retrieval：先检索语义相近的 workflow routing profile，再选择候选。
- LLM judgment：让 LLM 基于 workflow metadata 做结构化路由判断。

推荐方向：分阶段实现混合语义路由。保留当前 lexical router 作为快速、确定性的 baseline；先增加 LLM structured routing，因为它能复用现有 `LlmClient` 边界，基础设施成本更低；当 workflow catalog 大到把所有 workflow profile 都传给 LLM 会太慢或太贵时，再引入 RAG retrieval。长期形态应是 RAG 生成候选集，再由 LLM 对小候选集做裁决。

## 当前状态

当前 engine 行为：

- `WorkflowEngine` 只在 `session.activeWorkflowIds` 为空时执行路由。
- 已有 active workflow 的 session 会继续沿用这些 active workflows，不会重新运行本地关键词匹配。
- `findMatchingWorkflows(...)` 会通过 `scoreWorkflow(...)` 给每个已注册 workflow 打分。
- 被接受的 workflow 会 attach 到 session，并按分数顺序运行。
- 如果没有 workflow 分数达到 `localAccept`，最佳候选在达到 `localUncertain` 时仍可被路由。
- 如果没有候选符合条件，engine 返回现有 fallback：`我还不能确定要执行哪个 workflow。`

当前 routing metadata：

- `description`：workflow 覆盖范围的人类可读描述。
- `routing.examples`：典型用户说法。
- `routing.entities`：核心业务实体和词项。
- `routing.neighbors`：相邻 workflow id，表示语义相关但不应被误选的 workflow。
- `routing.thresholds.localAccept`、`localUncertain` 和 `globalAccept`。

当前限制：

- 精确子串匹配会漏掉改写、同义词、错别字、领域别名和跨语言表达。
- description 词项匹配噪声较大，因为按标点和空白切词并不能建模业务意图。
- 接近的 workflow 容易冲突。例如股票摘要、趋势、估值、异动原因、仓位策略等 workflow 可能共享股票名、代码和通用词，但真实意图不同。
- `neighbors` 和 `globalAccept` 目前没有被本地 router 充分使用。
- routing confidence 是手工校准的，不同 scenario domain 之间不可直接比较。
- 增加 examples 可以提高召回，但会让 metadata 更大、更难维护。

## 目标

- 提高对语义正确但不包含精确关键词的用户请求的 routing recall。
- 当多个 workflows 共享实体但任务意图不同时，提高 routing precision。
- 保持当前运行时边界：routing 只选择 workflow；patch 仍负责结构化业务信息抽取。
- 保持 active workflow 行为，除非未来有新的 RFC 明确修改 session lifecycle。
- 保留确定性的本地 routing，用于 fast path、测试和降级运行。
- 产出可追踪的 routing decision，包含 score、source 和便于调试的 evidence。
- 对动态模型响应继续使用 schema-validated 边界。

## 非目标

- 不把业务字段抽取迁移到 routing。
- 不在 routing 中调用 connector。
- 不增加 patch retry 逻辑，也不改变 patch structured-output 语义。
- 不让 `agents/**` 的 procedure 文件成为 runtime dependency。
- 不强制需要确定性本地 routing 的用户调用远程模型。

## 方案 A：RAG / Embedding Retrieval

### 设计

在 engine 构造时，或通过显式 warmup step，构建 workflow routing documents 的索引。每个 workflow 提供一个或多个 document：

- workflow identity：`id`、`version`
- workflow `description`
- routing `examples`
- routing `entities`
- routing `neighbors`，作为负向或相邻提示
- 未来可选的 authoring-time `routing.summary`，用于 examples/entities 不足的场景

路由时：

1. 如果 `session.activeWorkflowIds` 非空，保持当前 active routing。
2. 先运行 lexical scoring，作为廉价的精确匹配 fast path。
3. 对最新用户消息做 embedding，可选地拼入短 conversation summary。
4. 基于向量相似度检索 top-K workflow documents。
5. 把 retrieval scores 归一化为 `0..1` 的 routing confidence。
6. 接受高于 `globalAccept` 的候选；如果没有候选通过，可选地在最佳候选超过不确定阈值时返回它。
7. 发出 `routing.rag` 等 trace，包含 matched ids、similarity scores 和 source document ids。

第一版可以为本地 agents 使用 in-memory index。后续如果 workflow catalog 很大，或需要跨进程共享索引，可以允许可插拔 vector store。

### 候选结果形态

```ts
interface RoutingCandidate {
  workflowId: string;
  score: number;
  source: "lexical" | "embedding";
  evidence: string[];
}
```

`evidence` 应该是短 snippet 或 document label，而不是完整 procedure 文本。它用于诊断和 LLM adjudication，不作为用户可见输出。

### 优点

- 比子串匹配更能处理改写和同义表达。
- 当 workflow 数量增长时，比把每个 workflow profile 都发给 LLM 更容易扩展。
- 可以作为更强 ranker 前面的 candidate retrieval。
- 在 embedding model 和 index 固定时，路由结果相对确定。
- 可以用 fake embedder 和 fixture vectors 测试，不需要真实模型调用。

### 风险

- 需要新增 embedding dependency 和 index lifecycle。
- similarity score 天然不具备跨模型、跨领域校准能力。
- embedding 可能检索出语义相关但业务上不该执行的 neighbor。
- 单独使用 RAG 不可靠地处理否定、多意图表达或细微 workflow 边界。
- 远程 embedding provider 会引入成本、延迟、隐私和可用性问题。
- workflow 动态加载时，index staleness 会成为真实失败模式。

### 适用场景

RAG 最适合作为 candidate generation，适用于：

- workflow 数量较多；
- workflow metadata 足够丰富，适合 embedding；
- latency/cost 使全量 workflow LLM judgment 不划算；
- 系统可以接受维护一个索引。

当 workflow 数量不多但语义非常接近时，RAG 不适合作为唯一 router，因为它检索的是相似性，而不是显式业务决策。

## 方案 B：LLM 结构化路由判断

### 设计

复用现有 `deps.llm.structured(...)` 边界，让模型返回 routing decision。Prompt 输入包含：

- 最新用户消息；
- 可选 session facts、goals、constraints 和 conversation summary；
- 来自 `workflowForLlm(...)` 的 candidate workflow profiles；
- routing rules，说明 router 职责并禁止业务字段抽取；
- neighbor hints，说明相邻 workflow 不应仅因相似就被选中。

响应必须通过 schema validate。可选 schema：

```ts
const RoutingDecisionSchema = z.object({
  matches: z.array(
    z.object({
      workflowId: z.string(),
      confidence: z.number().min(0).max(1),
      rationale: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
  clarification: z.string().optional(),
});
```

Engine 行为：

1. 如果 active workflows 存在，保持当前 active routing。
2. 先运行 lexical scoring。
3. 如果 lexical confidence 明确可接受且不歧义，则不调用 LLM，直接路由。
4. 否则让 LLM 判断全部 workflows，或判断预筛后的 candidate set。
5. 用 registry 校验 workflow ids；丢弃未知 id。
6. 接受高于每个 workflow `globalAccept` 的决策。
7. 如果模型没有返回任何 accepted workflow，则 fail closed，并保留现有 fallback 行为。
8. 发出 `routing.llm` 等 trace，包含 workflow ids、confidences 和短 rationale。

### 优点

- 对自然语言歧义、否定和意图边界的处理能力最强。
- 基础设施成本低于 embedding，因为 `LlmClient` 已经存在。
- 可以直接使用现有 workflow metadata，包括 `neighbors`。
- structured output 可以约束未知字段，并校验 confidence values。
- 更容易为真正歧义的用户请求增加 clarification path。

### 风险

- routed turns 会增加延迟和成本。
- 模型输出不如 lexical scoring 确定。
- 如果传入每个 workflow profile，prompt size 会随 workflow 数量线性增长。
- 如果 prompt 和 schema 不够严格，模型可能基于薄弱证据过度推断用户意图。
- 如果模型调用失败，除非定义 fallback 行为，否则 routing 会被阻塞。
- 单元测试必须使用 fake LLM client；真实 provider smoke test 仍保持手动执行。

### 适用场景

LLM judgment 最适用于：

- workflow 数量较少或中等；
- workflows 语义接近，需要显式意图推理；
- engine 已经配置模型；
- routing 正确性比新 session 多一次模型调用更重要。

当 workflow catalog 很大时，LLM judgment 不适合作为全量 workflow router，因为成本和 prompt size 会随已注册 workflow 数量线性增长。

## 方案 C：混合语义 Router

### 设计

混合 router 组合确定性 routing、RAG candidate generation 和 LLM adjudication：

1. active workflow routing 保持不变。
2. 先运行 lexical router。
3. 如果 lexical result 高置信且不歧义，立即接受。
4. 如果 lexical result 为空、较弱或歧义，则用 RAG 检索 top-K semantic candidates。
5. 如果某个 RAG candidate 高置信，且显著领先下一个候选，则接受它。
6. 否则只把小候选集交给 LLM structured routing。
7. 如果 LLM 接受高于 `globalAccept` 的候选，则 attach 这些 workflows。
8. 如果 LLM 拒绝或 validation 失败，则按配置 fail closed，或回退到 lexical-only 行为。

这样可以把昂贵的模型调用聚焦在歧义场景，并让 RAG 成为扩展性机制，而不是最终事实来源。

### 推荐分阶段落地

Phase 1：Routing strategy boundary

- 引入内部 `WorkflowRouter` 抽象。
- 把当前关键词行为移到 `LexicalWorkflowRouter` 后面。
- 保持当前 public API 和默认行为不变。
- 增加能明确 source 和 score 的 traces。

Phase 2：LLM structured router experiment

- 增加 opt-in 的 `LlmWorkflowRouter`，并只在没有 active workflows 时使用。
- 使用 `workflowForLlm(...)` 作为 profile projection。
- 用 Zod 校验模型输出。
- 对 invalid ids、invalid confidence 或 malformed output fail closed。
- 补 fake-LLM 单元测试，覆盖 accept、reject、multi-match、ambiguous 和 invalid-output。

Phase 3：RAG candidate retrieval

- 在 routing options 后面增加 opt-in embedder/index dependency。
- 从已注册 workflow routing profiles 构建 in-memory index。
- 检索 top-K candidates，并在需要 adjudication 时交给 LLM router。
- 补 fake-embedder 测试和 scenario routing fixtures。

Phase 4：校准后启用 Hybrid default

- 只有当 scenario test reports 证明 precision/recall 优于 lexical routing 后，才默认启用 hybrid routing。
- 保留 lexical-only mode 作为支持的降级路径。
- 如果 public surface 发生变化，同步在 `docs/API.md` 和 package README 中记录 routing 配置和 provider 要求。

## 建议的内部 API 形态

第一版保持在 `@pac/engine` 内部，避免过早承诺 public API。

```ts
interface RoutingInput {
  message: string;
  session: EngineSession;
  workflows: readonly RuntimeWorkflow[];
}

interface RoutingResult {
  matches: RoutingCandidate[];
  source: "lexical" | "llm" | "rag" | "hybrid";
  clarification?: string;
}

interface WorkflowRouter {
  route(input: RoutingInput): Promise<RoutingResult>;
}
```

一旦引入 LLM 或 embedding routing，`WorkflowEngine.selectTargetWorkflows(...)` 需要变成 async。`onMessage(...)` 已经是 async，因此这个变化应该只影响 engine 内部。

## 阈值语义

当前 local thresholds 应保持 local 语义：

- `localAccept`：lexical fast-path 接受阈值。
- `localUncertain`：lexical 弱 best-match 阈值。

语义 routing 应使用：

- `globalAccept`：LLM/RAG/hybrid 接受阈值。

这样可以让现有阈值名变得有意义，同时不改变 workflow authoring 数据。如果未来校准证明 RAG 和 LLM 需要独立阈值，应新增显式字段，而不是隐式重载 `globalAccept`。

## 失败策略

默认失败策略应为 fail-closed：

- LLM 输出中的未知 workflow ids 被忽略并记录 trace。
- malformed structured output 不产生 semantic matches。
- provider failures 不产生 semantic matches。
- 如果之前已有 lexical fast-path match，engine 仍可使用它。
- 如果最终没有 match，返回当前 fallback response。

不要因为 semantic router 失败就静默运行某个 workflow。运行错误 workflow 比要求用户澄清更危险。

## 测试计划

单元测试：

- 默认配置下 lexical router 行为保持不变；
- active workflow sessions 绕过 semantic routing；
- fake LLM 接受高于 `globalAccept` 的明确 route；
- fake LLM 拒绝无关消息；
- fake LLM 返回多个 accepted workflows 时，engine 运行所有选中 workflows；
- fake LLM 返回未知 workflow ids 时，engine 忽略这些 id；
- fake LLM malformed output fail closed；
- fake embedder 确定性检索 top-K candidates；
- hybrid router 只在 ambiguous 或 weak candidate sets 时调用 LLM。

Scenario tests：

- maintenance workflow 仍能路由 `预约保养`；
- investment-advisor 的 close-intent cases 能正确路由股票摘要、趋势、估值、异动原因、仓位策略、财务和对比 workflow；
- mixed-intent cases 在 procedure metadata 表明可并行运行时，选择所有 expected target workflows；
- 无关请求返回现有 no-workflow fallback。

手动 smoke tests：

- 仅在配置真实 LLM provider 时运行 `npm run scenario:maintenance`；
- LLM/RAG routing opt-in 后，新增独立的 semantic-routing smoke test。

## 指标

每个 routing turn 记录：

- selected workflow ids；
- 按 source 记录 candidate ids 和 scores；
- accepted/rejected reason codes；
- LLM routing latency 和 token usage；
- embedding latency 和 cache hit rate；
- no-route rate；
- 如果产品侧有遥测，记录 user correction rate；
- shadow mode 下 lexical、RAG 和 LLM candidates 的 disagreement。

## 安全与隐私

- Routing prompts 只能包含 routing metadata 和最小 session context。
- 除非经过单独隐私评审，否则不要把 connector results 或 private tool outputs 发送给 routing model。
- Embedding indexes 应从 workflow metadata 重建，而不是从用户 conversation logs 构建。
- 远程 embedding 和 LLM providers 必须遵循现有 LLM client 相同的配置和 secret-handling 规则。

## 推荐方案

采用 hybrid 方向，但分阶段实现：

1. 先创建内部 router abstraction，并保留关键词 routing 作为默认行为。
2. 增加 opt-in LLM structured routing，因为它能复用现有 `LlmClient`、`workflowForLlm(...)`、Zod validation 和 trace patterns。
3. 当 workflow 数量或 routing prompt size 使全量 workflow LLM judgment 变贵时，再引入 RAG retrieval。
4. 在有足够 scenario evidence 后，把默认语义 router 演进为 RAG candidate retrieval 加 LLM adjudication。

这条路径能提升 PAC 的路由能力，同时避免过早承诺 vector infrastructure，也避免让每个新 session 都依赖模型调用。

## 待确认问题

- 歧义 semantic routes 应该询问 clarification question，还是保持当前通用 no-workflow fallback？
- workflow 数量达到什么规模时，应从全量 workflow LLM judgment 切换到 RAG candidate retrieval？
- `routing.neighbors` 是否应继续只支持 workflow ids，还是支持解释性 negative examples？
- route examples 应该由 `procedure.md` 在 authoring time 生成，还是继续由 workflow metadata 手写维护？
- semantic routing 应按 engine、workflow 还是 session 配置？
