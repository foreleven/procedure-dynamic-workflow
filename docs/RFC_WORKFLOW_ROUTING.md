# RFC：Workflow Routing OOP 与 Flash Gate

状态：已实现
日期：2026-06-15
目标包：`@pac/engine`，必要时同步 `@pac/workflow` session 类型

## 结论

本期把 routing 从 `routing.ts` 的关键词函数改成 OOP 子系统，并使用低延迟 LLM 做 workflow-level structured gate。

本期不上 RAG / embedding。只预留 `WorkflowCandidateProvider` 接口，等 workflow 数量特别多、全量 compact profiles 进入 gate prompt 的延迟或 token 成本不可接受时，再用 RAG provider 替换默认候选生成器。

必须支持两类 session：

1. 新 session：一定先做 workflow 匹配，再执行 workflow。
2. 已有 session：routing gate 与当前 active workflow 的 patch 路径并行执行；gate prompt 使用 session memory + 最新 N 条消息，和新 session prompt 不同。

后续需要考虑 agent 是否支持闲聊。如果支持，应把闲聊做成一个兜底 workflow，而不是让 engine 在 workflow 外生成闲聊回复。

## 非目标

- 不实现 RAG、embedding index、LanceDB/hnswlib/faiss。
- 不让 routing 抽取业务字段；业务 state 仍由 workflow patch 负责。
- 不让 routing 调 connector、运行 node、生成用户回复。
- 不增加 patch retry。
- 不用业务关键词 gate 代替 LLM gate。

## 类结构

建议保留 `packages/engine/src/routing.ts` 作为 facade，并新增内部目录：

```text
packages/engine/src/routing/
  router.ts
  llm-workflow-router.ts
  route-gate.ts
  candidate-provider.ts
  protocol-fast-path.ts
  routing-plan-applier.ts
  workflow-profile.ts
  schemas.ts
```

核心类：

- `WorkflowRouter`：engine 的唯一 routing 入口。
- `LlmWorkflowRouter`：本期默认实现。
- `RouteGate` / `FlashLlmRouteGate`：低延迟 LLM structured gate。
- `WorkflowCandidateProvider`：候选 workflow provider，本期默认全量 compact profiles，未来可替换 RAG。
- `ProtocolFastPath`：只处理 ack/selection 这类协议短回复。
- `RoutingPlanApplier`：集中修改 `session.activeWorkflowIds` 和 attach instances。

## 核心类型

```ts
type RoutingAction = "continue" | "switch" | "parallel" | "clarify" | "none";

interface WorkflowRoutingResult {
  action: RoutingAction;
  targetWorkflowIds: WorkflowId[];
  suspendedWorkflowIds: WorkflowId[];
  clarification?: string;
}

abstract class WorkflowRouter {
  abstract route(input: WorkflowRoutingInput): Promise<WorkflowRoutingResult>;
}

interface WorkflowRoutingInput {
  message: string;
  session: EngineSession;
  workflows: readonly RuntimeWorkflow[];
  activeInstances: readonly WorkflowInstance<JsonRecord>[];
  recentMessages: readonly WorkflowMessage[];
}
```

```ts
interface WorkflowRoutingProfile {
  id: WorkflowId;
  version: string;
  description: string;
  examples: string[];
  entities: string[];
  neighbors: WorkflowId[];
  isFallback?: boolean;
}
```

```ts
abstract class WorkflowCandidateProvider {
  abstract getCandidates(input: WorkflowCandidateInput): Promise<WorkflowRoutingProfile[]>;
}
```

本期默认 `AllWorkflowCandidateProvider` 返回所有 workflow 的 compact profile，但要有数量上限，例如 `maxWorkflowProfiles = 64`。超过上限时 fail closed 或要求显式配置 provider，不要偷偷退回关键词筛选。

## Routing Action 语义

- `continue`：继续当前 active workflows。
- `switch`：暂停当前 active workflows，切到目标 workflows。
- `parallel`：保留当前 active workflows，并追加目标 workflows。
- `clarify`：不执行 workflow，要求用户澄清。
- `none`：没有可执行 workflow，返回现有 no-workflow fallback。

## Routing 集合语义

`targetWorkflowIds` 是本轮最终要执行 patch / nodes / render 的 workflow 集合，不是“新增 workflow 集合”。它是 per-turn 结果，不应作为长期状态保存。长期状态仍是 `session.activeWorkflowIds` 和 `session.routingMemory.suspendedWorkflowIds`。

进入 `targetWorkflowIds` 的规则：

- 新 session：gate 选中的业务 workflow 进入；如果没有业务 workflow 且配置了 fallback chat workflow，则 fallback workflow 进入。
- 已有 session + protocol fast path：当前 `session.activeWorkflowIds` 全部进入。
- `continue`：当前 `session.activeWorkflowIds` 全部进入。
- `switch`：gate 返回的新 active set 进入。这个集合会替换当前 `session.activeWorkflowIds`。
- `parallel`：当前 `session.activeWorkflowIds` 与 gate 返回的新 workflow 合并后进入。
- `clarify` / `none`：不进入任何业务 workflow；`targetWorkflowIds` 为空。

从 `targetWorkflowIds` 移除的规则：

- `targetWorkflowIds` 每轮重新计算；上一轮目标不会自动继承到下一轮。
- 当前 active workflow 在 `switch` 后未出现在新 target 中，则本轮不再执行，并从下一轮 active set 中移除。
- LLM 返回 unknown workflow id、低置信、或 malformed output 时，相关 workflow 不进入 target。
- `clarify` / `none` 不执行 workflow，因此 target 清空。

进入 `suspendedWorkflowIds` 的规则：

- 只有 `switch` 会把 workflow 放入 suspended。
- 具体集合是：`previousActiveWorkflowIds - targetWorkflowIds`。
- `continue` 不新增 suspended。
- `parallel` 不新增 suspended，因为原 active workflows 仍继续执行。
- `clarify` / `none` 不新增 suspended，避免一次歧义判断改变 session 生命周期。

从 `suspendedWorkflowIds` 移除的规则：

- 某个 suspended workflow 再次进入 `targetWorkflowIds` 时，从 suspended 移除，相当于恢复执行。
- workflow id 不再存在于 registry 时，从 suspended 移除。
- 本期没有 workflow completed/cancelled lifecycle 信号，因此不做基于完成态的自动清理；如果后续引入 lifecycle，应在 completed/cancelled 时从 active 和 suspended 中移除。

状态转移表：

| action | targetWorkflowIds | session.activeWorkflowIds after apply | suspendedWorkflowIds after apply |
| --- | --- | --- | --- |
| `continue` | 当前 active | 不变 | 不变 |
| `switch` | gate 返回的新 active set | 替换为 target | 加入 previous active 中未进入 target 的 workflow；移除已进入 target 的 suspended workflow |
| `parallel` | 当前 active + gate 返回的新 workflows | 替换为 target | 不新增；移除已进入 target 的 suspended workflow |
| `clarify` | 空 | 不变 | 不变 |
| `none` | 空 | 不变 | 不变 |

fallback chat workflow 一旦被选中，就按普通 workflow 进入 `targetWorkflowIds`，对应 action 必须是 `switch` 或 `parallel`；真正的 `none` 永远不执行 workflow。已有 session 命中 fallback 时应使用 `parallel` 还是 `switch` 仍是开放问题。

## 新 Session 流程

新 session 没有 active workflow，必须先做 workflow 匹配。

```text
user message
  -> candidate provider
  -> new-session route gate
  -> validate decision
  -> attach target workflows
  -> append user message
  -> patch / nodes / render
```

新 session gate prompt 输入：

- 最新用户消息；
- agent 下所有 compact workflow profiles；
- 可选 agent metadata；
- 可选 fallback chat workflow profile。

新 session gate 不需要 session memory，也不需要历史消息。

如果 gate 返回 `none`：

- 返回当前 no-workflow fallback。

如果 agent 支持 fallback chat workflow，fallback 应作为候选 workflow 交给 gate。gate 选中 fallback 时返回 `switch` 和 fallback 的 `targetWorkflowIds`，而不是返回 `none`。

## 已有 Session 流程

已有 session 不应默认粘死 active workflow。每轮都要让 route gate 判断是否继续、切换、并行或澄清。Gate 只决定 target workflow 集合；patch 必须留在 workflow instance 自己的完整执行链路中。

```text
user message
  -> protocol fast path?
      yes -> continue active workflows, skip gate
      no  -> route gate
  -> validate routing decision
  -> run each target workflow instance independently
  -> engine merges/selects completed workflow responses
```

已有 session gate prompt 输入：

- session memory；
- 最新 N 条消息；
- 当前 active workflow profiles；
- candidate workflow profiles；
- pending ack summary；
- 最新用户消息。

这里的 prompt 与新 session 不同。它的任务不是“从零选择 workflow”，而是判断：

- 用户是否仍在推进当前 active workflow；
- 用户是否开始了新任务；
- 新任务是否应该替换当前 workflow；
- 新任务是否应该和当前 workflow 并行；
- 是否需要澄清。

## Workflow Instance 独立执行

Routing 决策完成后，进入 target 的每个 workflow instance 独立执行完整链路。Patch 不再 speculative 执行，因为 patch 必须看见该 workflow 本轮 `beforePatch` / `withPatch` 产生的 workflow-local facts。

单个 instance 的顺序：

```ts
instance.state.messages = [...instance.state.messages, latestUserMessage];
runBeforePatch(instance);
runWithPatch(instance);
applyPatch(instance, extractPatch(instance));
runAfterPatchUntilStable(instance);
const response = render(instance);
return { workflowId: instance.id, response };
```

Engine 层只负责调度这些 instance promise，并在全部 response 到达后选择或合并最终输出。

## Protocol Fast Path

短回复可以 skip gate，但只能基于协议状态，不做业务关键词判断。

条件：

1. session 有 active workflow；
2. active workflow context 中有 pending ack；
3. `instance.context.resolveAck(message)` 能解析该消息。

命中后直接 `continue` 当前 active workflow。

如果没有 pending ack，即使消息很短，也必须走 route gate。例如 `买比亚迪`、`查保险`、`取消预约`、`看走势`。

## Route Gate 输出

`FlashLlmRouteGate` 使用 `deps.llm.structured(...)`。

```ts
const RouteGateDecisionSchema = z.object({
  action: z.enum(["continue", "switch", "parallel", "clarify", "none"]),
  targetWorkflowIds: z.array(z.string()),
  suspendedWorkflowIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});
```

校验规则：

- workflow id 必须存在。
- `continue` 只能用于已有 active workflow。
- `switch` / `parallel` 必须有 target workflow。
- `suspendedWorkflowIds` 必须是当前 active workflow 的子集；最终可由 engine 根据 action 重新计算，不能盲信模型输出。
- 低 confidence 降级为 `clarify` 或 `none`。
- malformed output fail closed。
- gate rationale 只进 trace，不展示给用户。

## Session Memory

后续要给 session 增加 memory。Routing 只读 memory，不写业务事实。

建议形态：

```ts
interface SessionRoutingMemory {
  summary?: string;
  lastMatchedWorkflowIds: WorkflowId[];
  suspendedWorkflowIds?: WorkflowId[];
  lastRoutingAction?: RoutingAction;
}
```

已有 session gate 使用：

- `session.routingMemory.summary`
- 最新 N 条消息，例如 6 到 12 条；
- active workflow ids；
- suspended workflow ids；
- last matched workflow ids。

memory 更新不属于本 RFC 的核心实现，可以先由现有 session summary 或后续 memory 模块提供。

## 兜底闲聊 Workflow

Agent 是否支持闲聊应由 agent/workflow 配置表达，不应写死在 engine。

建议未来支持：

```ts
interface WorkflowRoutingProfile {
  id: WorkflowId;
  description: string;
  examples: string[];
  entities: string[];
  neighbors: WorkflowId[];
  isFallback?: boolean;
}
```

规则：

- 一个 agent 最多一个 fallback chat workflow。
- 业务 workflow 明确匹配时，不选 fallback。
- 没有业务 workflow 匹配且 agent 支持闲聊时，选 fallback。
- fallback workflow 仍走正常 patch / render 机制，不由 engine 直接闲聊。

## RAG 预留

本期只预留：

```ts
class EmbeddingWorkflowCandidateProvider extends WorkflowCandidateProvider {
  // future only
}
```

未来只替换 candidate provider，不改 route gate 和 routing plan applier。

触发条件：

- workflow 数量超过 `maxWorkflowProfiles`；
- gate prompt token/latency 不可接受；
- 多 agent 或多进程需要共享 routing index。

## Engine Options

```ts
interface WorkflowRoutingOptions {
  router?: WorkflowRouter;
  gate?: RouteGate;
  candidateProvider?: WorkflowCandidateProvider;
  gateModel?: string;
  maxWorkflowProfiles?: number;
  recentMessageLimit?: number;
}
```

如果这些作为 public API 暴露，需要同步 `docs/API.md` 和 package README。

## Trace

新增 trace phases：

- `routing.gate.new_session`
- `routing.gate.existing_session`
- `routing.protocol_fast_path`
- `routing.continue`
- `routing.switch`
- `routing.parallel`
- `routing.clarify`
- `routing.none`
- `response.merge`

Trace 不记录完整 prompt、完整 memory 或私有消息内容。

## 测试

单元测试：

- 新 session 一定调用 gate 并 attach gate 返回的 workflow。
- 已有 session 无 protocol fast path 时，先 gate，再运行 target workflow instance。
- pending ack 短回复 skip gate。
- 无 pending ack 的短消息仍调用 gate。
- `continue` 执行当前 active workflow instances。
- `switch` 只执行新 target workflow instances。
- `parallel` 执行当前 active 与新增 workflow instances。
- unknown workflow id / malformed output fail closed。
- fallback chat workflow 只在无业务 workflow 匹配时被选中。
- `switch` 时 previous active 未进入 target 的 workflow 进入 suspended。
- suspended workflow 被重新选中进入 target 后，从 suspended 移除。

## 迁移步骤

1. 新增 routing OOP 子目录与接口。
2. 增加 `LlmWorkflowRouter`、`FlashLlmRouteGate`、`AllWorkflowCandidateProvider`。
3. 将 `selectTargetWorkflows(...)` 改为 async，并委托 router。
4. 让 target workflow instance 独立执行完整 patch / nodes / render 链路。
5. 增加 protocol fast path。
6. 增加 fake gate 单元测试。
7. 若 routing options 暴露为 public API，同步文档。

## 后续仍需决策

下面这些点不阻塞本期实现，但会影响后续长期会话、fallback 闲聊和多 workflow 输出体验：

- 已有 session 命中 fallback chat workflow 时，是默认 `parallel` 保留业务 workflow，还是 `switch` 暂停业务 workflow？
- `clarify` 本期由 routing 层直接返回澄清文案，还是继续复用 no-workflow fallback？
- workflow 何时算 completed/cancelled 还没有 lifecycle 信号；没有这个信号时，active/suspended 只能靠 gate 切换和 registry 校验清理。
- 多个 target workflows 同轮 render 时，primary response 的顺序如何确定；当前 engine 默认取第一个 response。
- session memory 的来源、更新时机、summary 长度和最新 N 条消息的 N 值还需要配置边界。
- `WorkflowEngineOptions.routing` 是否作为 public API 暴露；如果暴露，需要同步 `docs/API.md` 和 package README。
