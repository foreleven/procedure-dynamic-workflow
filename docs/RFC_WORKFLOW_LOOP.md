# RFC：Workflow Loop 节点

状态：提案
日期：2026-06-18
目标包：`@pac/workflow`、`@pac/engine`

## 背景

PAC workflow 当前是一次用户 turn 内的固定执行链路：

```text
route -> patch -> effects until stable -> render
```

这个模型适合“用户事实已经足够，effect 做确定性 connector 读取或外部写入”的场景。但公开资料研究、排障诊断、候选筛选、数据核验等任务，经常需要一个受控的多 pass 过程：

```text
plan pass 1 -> execute connectors -> inspect evidence
plan pass 2 -> execute connectors -> inspect evidence
plan pass 3 -> stop or close gaps -> render
```

现有 API 的问题不是 effect 不能多次调用 connector，而是 workflow author 缺少一个通用控制结构来表达：

- 这一轮是否已经满足；
- 下一轮需要做什么；
- 最多跑几轮；
- 多个 loop 如何共存；
- loop 的控制状态如何与 durable workflow state 分离。

直接在业务 workflow 里手写 `for` 循环会重复实现 planner、执行、停止条件、trace、错误处理和轮次预算。嵌套 callback 形式的 loop 也会让复杂 workflow 缩进变深、可读性变差。

## 目标

引入一个通用 `loop` program primitive，用于在现有 workflow 模型内表达受控多 pass 执行。

目标：

1. 支持一个 workflow 中声明多个 loop。
2. 使用非嵌套 authoring 形态：`const loop1 = loop("name", config)`，再通过 `loop1.effect(...)` 注册 loop 内节点。
3. loop 拥有内置控制状态，例如当前 run、最大 run、最近 loop state、是否满足、停止原因。
4. loop 控制状态不进入 workflow business state。
5. loop planner 使用 schema-validated structured output。
6. loop 内 effect 复用现有 connector、ToolMessage、step trace 和错误边界。
7. engine 负责 loop 调度、最大轮次、planner 调用、稳定性和 trace。
8. 保持 patch 的职责不变：只抽取用户表达的 durable business facts。

## 非目标

- 不引入业务特化的 `researchLoop`、`diagnosisLoop`、`triageLoop`。
- 不让 effect 触发 patch。
- 不支持多个 named patch。
- 不把 loop state、原始候选列表、搜索结果、页面正文或中间总结自动写入 workflow business state。确实需要 handoff 时，`loop.effect` 或依赖 loop 完成的普通 `effect` 可以返回 compact state patch。
- 不替代 command。不可逆外部写入仍必须通过 `command`。
- 不改变 render 是唯一用户可见输出路径的原则。

## 如何减少重复代码

`loop` 的价值是把每个多 pass workflow 都会重复写的一层控制逻辑收进 runtime，而不是把业务 connector 调用也抽象掉。

Runtime 统一负责：

- planner structured output 调用；
- `maxRuns` 预算；
- `continue/satisfied/blocked/max_runs` 状态机；
- 每一 run 的 loop-local dependency memory；
- loop state ToolMessage 记录；
- trace 事件；
- planner output 校验、失败回滚和定义期校验。

Workflow author 只写：

- durable state 的最小 schema；
- loop 的业务 instruction 和 state schema；
- loop body effects，也就是“拿到本轮 loop state 后具体调用哪些 connector”；
- render 如何基于 ToolMessages 总结。

这样不同 procedure 可以复用同一个 loop runtime，只替换 state schema、instruction 和 body effects。代码重复集中在可复用的普通 helper 上，例如 `toSearchInput(...)`、`toEvidenceMessages(...)`、`compactEvidenceRefs(...)`，而不是每个 workflow 都手写一套循环控制、停止判断和 trace。涉及语义判断的选择，例如“哪些 URL 值得抽取”，应由 loop planner 输出结构化 loop state。

## 核心设计

### Authoring 形态

`workflow(...)` 返回新增的 `loop` builder：

```ts
const { patch, effect, loop, render } = workflow<State, ConnectorCatalog>({
  stateSchema,
  state: initialState,
  invalidation,
});
```

声明 loop：

```ts
const researchLoop = loop("researchPasses", {
  description: "Runs bounded evidence-gathering passes for the current research questions.",
  dependsOn: ["researchQuestions"],
  maxRuns: 3,
  stateSchema: ResearchPassStateSchema,
  instruction: `
Read the durable research questions and previous tool evidence.
If current evidence is enough, set status to satisfied.
Otherwise produce the next bounded set of research queries.
Do not expand beyond the user's requested scope.
`,
});
```

注册 loop 内节点：

```ts
researchLoop.effect("searchPlannedQueries", ["loop.state"], {
  description: "Runs planned search queries for the current research pass; search results remain tool evidence.",
  run: async (state, context, runtime, step) => {
    const loopState = runtime.loop.state;
    const searchActions = loopState.actions.filter((action) => action.kind === "search");
    if (searchActions.length === 0) return {};

    const loading = step.start("搜索候选来源", {
      loop: runtime.loop.name,
      run: runtime.loop.run,
      queryCount: searchActions.length,
    });

    const searches = await Promise.all(
      searchActions.map((action) =>
        context.call("connectors.web.search", toSearchInput(action), {
          cache: true,
        }),
      ),
    );

    loading.end({ resultSets: searches.length });

    return {
      messages: toSearchToolMessages(loopState, searches),
    };
  },
});

researchLoop.effect("extractPlannedPages", ["loop.state"], {
  description: "Extracts model-selected high-value pages from the current loop state.",
  run: async (state, context, runtime, step) => {
    const loopState = runtime.loop.state;
    const urls = loopState.actions
      .filter((action) => action.kind === "extract")
      .flatMap((action) => action.urls);
    if (urls.length === 0) return {};

    const loading = step.start("抽取高价值页面", {
      loop: runtime.loop.name,
      run: runtime.loop.run,
      urlCount: urls.length,
    });

    const extracted = await context.call(
      "connectors.web.extractPages",
      {
        urls,
        query: loopState.passGoal,
        extractDepth: "basic",
        format: "markdown",
        includeFavicon: true,
      },
      { cache: true },
    );

    loading.end({
      extracted: extracted.results.length,
      failed: extracted.failedResults.length,
    });

    return {
      messages: [
        new ToolMessage({
          name: "connectors.web.extractPages",
          call: { urls, query: loopState.passGoal },
          result: extracted,
        }),
      ],
    };
  },
});
```

The loop builder is not a nested DSL. It is a named node owner.

### Naming

Use `maxRuns`, not `maxTurns`.

Reason: PAC already uses “turn” for user/assistant interaction turns. A loop run is an internal workflow pass inside one engine turn.

If product language strongly prefers “turn”, an alias can be considered later, but the public API should start with `maxRuns`.

## Loop State Protocol

Loop planning is LLM-backed structured output. The author supplies the loop state schema; runtime wraps it in a standard decision envelope.

Author loop state schema:

```ts
const ResearchPassStateSchema = z.object({
  passGoal: z.string(),
  actions: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("search"),
      label: z.string(),
      query: z.string(),
      topic: z.enum(["general", "news", "finance"]).optional(),
      includeDomains: z.array(z.string()),
      reason: z.string(),
    }),
    z.object({
      kind: z.literal("extract"),
      label: z.string(),
      urls: z.array(z.string().url()).max(8),
      reason: z.string(),
    }),
  ])).max(8),
});
```

Runtime envelope:

```ts
const LoopDecisionSchema = z.object({
  status: z.enum(["continue", "satisfied", "blocked"]),
  reason: z.string(),
  state: ResearchPassStateSchema.nullable(),
});
```

Semantics:

- `continue`: execute loop body effects for this run. `state` must be non-null.
- `satisfied`: stop the loop successfully. `state` must be null.
- `blocked`: stop the loop because more execution would be unsafe or ambiguous. `state` must be null.

The planner prompt receives:

- durable workflow state;
- current loop name;
- current run number and max runs;
- prior tool messages visible to this workflow;
- prior loop state decision messages for this loop;
- loop instruction.

The planner does not receive write access to workflow state or context.

### Planner Evidence Budget

Loop planning can become expensive if every pass feeds all extracted page bodies back to the model. V1 should give the engine a planner evidence view instead of blindly passing raw message history.

Planner input should include:

- durable workflow state;
- compact prior loop decisions for the same loop;
- recent ToolMessages from the same workflow, with connector call metadata;
- compact summaries or snippets of large connector outputs when the message exceeds the planner token budget;
- loop stop status from upstream loops referenced by `dependsOn`.

Planner input should not include:

- connector credentials or private runtime internals;
- full page bodies when compact evidence is enough for deciding the next pass;
- user-invisible scheduler bookkeeping unrelated to this loop.

This keeps loop planning focused on “what to do next” while render remains responsible for the final user-facing summary.

### Model Selection Inside A Loop

Search results often need model judgment before the workflow can know which URLs are worth extracting. That judgment should not be hidden inside a deterministic helper such as `selectExtractionCandidates(...)`.

V1 uses the loop planner as the model checkpoint:

1. A run can plan `search` actions.
2. Search effects execute those actions and append search ToolMessages.
3. The next planner call reads those ToolMessages and can plan `extract` actions with explicit URLs and reasons.
4. Extract effects execute only the model-selected URLs from the current loop state.

This means loop body effects execute a loop state; they do not perform semantic source selection on their own. If a use case needs `search -> model select -> extract` inside the same run, that requires a future model-backed loop child node. V1 keeps the model checkpoint at the boundary between runs.

## Runtime Loop State

Loop state is engine-owned runtime state:

```ts
interface LoopRuntimeState<TLoopState> {
  name: string;
  run: number;
  maxRuns: number;
  status: "continue" | "satisfied" | "blocked" | "max_runs";
  reason: string | null;
  state: TLoopState | null;
  messages: WorkflowToolMessage[];
}
```

This is not workflow business state. It is similar to scheduler state or step trace state.

Rules:

- It is scoped to the current workflow instance and current engine turn.
- It is checkpointed for rollback during the turn.
- It is not part of `stateSchema`.
- It is not patchable.
- It is not serialized as durable user-facing business state.
- Render sees loop outputs through normal workflow tool messages, not by reading internal loop control state.

The engine appends a tool message for each loop state decision:

```ts
new ToolMessage({
  name: "loop.researchPasses.state",
  call: {
    loop: "researchPasses",
    run: 1,
  },
  result: {
    status: "continue",
    reason: "...",
    state: { ... },
  },
});
```

This makes loop state reasoning auditable by render and by the next loop run without polluting durable state.

## Relationship To Workflow State

Workflow state stores durable business truth only.

Loop is not independent from workflow state. The relationship has three explicit directions:

1. State drives loop activation through `dependsOn`.
2. Loop reads durable state and prior ToolMessages when planning.
3. Loop body effects may return compact durable state patches, using the same state validation boundary as ordinary effects.

For the research example:

```ts
const ResearchStateSchema = z.object({
  status: z.enum(["collecting", "researching", "ready", "cancelled"]),
  researchQuestions: z.array(z.string()).default([]),
  blocker: z.enum(["missing_research_object", "evidence_unavailable"]).nullable(),
});
```

State owns:

- user-authorized research questions;
- lifecycle status;
- durable blockers that affect future turns.

Loop owns:

- current run index;
- whether current evidence is enough;
- next pass loop state;
- why it stopped.

Tool messages own:

- generated query plans;
- connector calls and results;
- selected source lists;
- extracted page evidence;
- loop state decisions.

Compact state patches may own:

- compact handoff facts for downstream loops, such as a short candidate competitor list;
- evidence references that point back to ToolMessages;
- lifecycle fields such as `status` or `blocker`.

This boundary prevents raw candidate lists, generated search terms, extraction URLs, and page bodies from becoming durable business state. A compact candidate list can be durable state only when it is intentionally produced by a state patch and carries evidence references.

`researchQuestions` is intentionally allowed to be an array because a user-visible research request can contain multiple durable sub-questions, such as “identify the top competitors” and “compare their market positioning.” Generated pass goals and rewritten queries are not durable questions; they belong to the loop state and ToolMessages.

## Multiple Loops

A workflow may declare multiple loops:

```ts
const discoveryLoop = loop("discovery", {
  description: "Discovers candidate entities or source clusters before deeper verification.",
  dependsOn: ["researchQuestions"],
  maxRuns: 2,
  stateSchema: DiscoveryStateSchema,
  instruction: "...",
});

const verificationLoop = loop("verification", {
  description: "Verifies claims and closes evidence gaps after discovery.",
  dependsOn: ["loop.discovery"],
  maxRuns: 2,
  stateSchema: VerificationStateSchema,
  instruction: "...",
});
```

Rules:

- Loop names must be globally unique within a workflow.
- Fully qualified node names are `loopName.nodeName`.
- `discovery.search` and `verification.search` may both exist because their fully qualified names differ.
- A top-level node name cannot collide with a loop name or fully qualified loop node name.
- Loop state tool message names are `loop.<loopName>.state`.
- Loop effect tool messages keep their connector/tool names unless the author creates derived tool messages.

### Loop Dependencies

Loop config `dependsOn` supports:

- state fields, e.g. `"researchQuestions"`;
- completed loop names with explicit namespace, e.g. `"loop.discovery"`.

State fields use current PAC dependency semantics. Loop dependencies mean the dependent loop can start after the referenced loop stops with `satisfied`, `blocked`, or `max_runs`.

In v1, `dependsOn: ["loop.discovery"]` means “wait for discovery to finish,” not “run only if discovery succeeded.” The dependent loop planner receives the upstream loop stop status and can immediately return `blocked` or `satisfied` if there is no useful work to do. Status-filtered loop dependencies can be added later if this extra planner call becomes a real cost.

Loop body effect dependencies support:

- `"loop.state"`: current run has a `continue` loop state;
- sibling loop effect names in the same loop and same run, e.g. `"searchPlannedQueries"`;
- a future version may add `"loop.messages"` if dependency on all prior loop messages proves necessary.

Loop body effect dependencies do not refer to workflow state. Workflow-state gating belongs to the parent loop `dependsOn`.

### Multiple Loop Scheduling

Multiple loops participate in the existing node graph like top-level effects:

- if loop B depends on `loop.A`, B starts only after A has stopped;
- if two loops depend on the same state field and do not depend on each other, v1 runs them in declaration order for deterministic traces;
- v1 does not run independent loops concurrently, because concurrent loop planners would compete for the same workflow messages and make evidence ordering ambiguous;
- top-level effects that depend on `loop.A` run after that loop stops, using existing invalidation semantics;
- top-level effects do not run between runs of the same loop. A loop node owns all of its internal runs before yielding back to the scheduler.

This makes `loop` a first-class node type without creating a second workflow language.

## Scheduling Semantics

For each executable loop:

```text
for run in 1..maxRuns:
  call planner
  append loop.<name>.state ToolMessage
  if decision.status is satisfied or blocked:
    stop loop
  execute loop body effects until stable for this run
  append returned ToolMessages
stop with max_runs if planner never satisfied/blocked
```

Important details:

- Body effects are registered once and replayed each loop run.
- Each run has fresh loop-local dependency memory.
- Existing `context.call(..., { cache: true })` still deduplicates identical connector inputs.
- Planner failures fail the loop node in v1.
- Body effect failures follow existing effect behavior unless the author catches connector errors and returns error ToolMessages.
- `maxRuns` is required and must be a finite integer from `1` to the v1 definition-time maximum of `5`. A default maximum if omitted is not allowed in v1.

## Loop Effects And Workflow State Updates

Loop body effects can return partial workflow state, using the same state validation and invalidation boundary as ordinary effects. This avoids adding a separate result or finalizer API.

V1 decision:

- `loop.effect(...)` may return `Partial<TState> & { messages?: WorkflowToolMessage[] }`.
- State patches from loop effects must be compact and schema-validated.
- Raw connector payloads, rewritten queries, selected URLs and extracted page bodies should remain ToolMessages.
- If a state patch summarizes external facts, it should carry evidence references back to ToolMessages.
- A normal top-level `effect` may depend on `loop.<name>` when state should be updated only after the loop has stopped.

When a later loop or workflow needs structured handoff data, a loop effect can contribute compact state:

```ts
const CandidateCompetitorSchema = z.object({
  name: z.string(),
  website: z.string().url().nullable(),
  category: z.enum(["direct", "indirect", "alternative", "adjacent"]),
  reason: z.string(),
  evidenceRefs: z.array(z.string()).min(1),
  confidence: z.enum(["low", "medium", "high"]),
});

const ResearchStateSchema = z.object({
  researchQuestions: z.array(z.string()).default([]),
  candidateCompetitors: z.array(CandidateCompetitorSchema).default([]),
});

const discoveryLoop = loop("discovery", {
  description: "Discovers candidate competitors with evidence references.",
  dependsOn: ["researchQuestions"],
  maxRuns: 3,
  stateSchema: DiscoveryStateSchema,
  instruction: "...",
});

discoveryLoop.effect("storeCandidateHandoff", ["extractPlannedPages"], {
  description: "Stores only compact discovered candidates for downstream analysis.",
  run: async (_state, _context, runtime) => ({
    candidateCompetitors: summarizeCandidates(runtime.loop.messages),
  }),
});

const marketLoop = loop("marketScan", {
  description: "Analyzes market signals for discovered candidate competitors.",
  dependsOn: ["candidateCompetitors"],
  maxRuns: 3,
  stateSchema: MarketScanStateSchema,
  instruction: "...",
});
```

If the update should happen only after the loop stops, use an ordinary effect:

```ts
effect("markResearchReady", {
  description: "Marks the research turn ready after bounded loop execution.",
  dependsOn: ["loop.discovery"],
  run: () => ({
    status: "ready",
  }),
});
```

This keeps `loop` small: loop effects can write state, and ordinary effects can react to loop completion.

## API Sketch

```ts
interface WorkflowProgram<TState, TConnectors> {
  patch(config: PatchConfig<TState>): void;
  prefetch(...): void;
  effect(...): void;
  command(...): void;
  loop<TLoopState>(
    name: string,
    config: LoopConfig<TState, TLoopState>,
  ): WorkflowLoopProgram<TState, TConnectors, TLoopState>;
  render(config: RenderConfig): WorkflowDefinition | WorkflowDefinitionTemplate;
}
```

```ts
interface LoopConfig<TState, TLoopState> {
  description: string;
  dependsOn: Array<(keyof TState & string) | `loop.${string}`>;
  maxRuns: number;
  stateSchema: z.ZodType<TLoopState>;
  instruction: string;
  model?: string;
}
```

```ts
interface WorkflowLoopProgram<TState, TConnectors, TLoopState> {
  effect(
    name: string,
    dependsOn: readonly string[],
    config: LoopEffectConfig<TState, TConnectors, TLoopState>,
  ): void;
}
```

```ts
interface LoopEffectRuntime<TLoopState> {
  loop: {
    name: string;
    run: number;
    maxRuns: number;
    state: TLoopState;
    decisionReason: string;
    messages: readonly WorkflowToolMessage[];
  };
}
```

Loop effect callback shape remains close to existing effect:

```ts
run: (
  state: TState,
  context: WorkflowContext<TConnectors>,
  runtime: WorkflowRuntimeInput & LoopEffectRuntime<TLoopState>,
  step: WorkflowStepController,
) => MaybePromise<Partial<TState> & { messages?: WorkflowToolMessage[] }>
```

Authors should still prefer ToolMessages for evidence-heavy data and reserve state patches for compact durable handoff facts.

## Example: Open Web Competitor Research

```ts
const ResearchStateSchema = z.object({
  status: z.enum(["collecting", "researching", "ready", "cancelled"]),
  researchQuestions: z.array(z.string()).default([]),
  blocker: z.enum(["missing_research_object", "evidence_unavailable"]).nullable(),
});

const ResearchPassStateSchema = z.object({
  passGoal: z.string(),
  actions: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("search"),
      label: z.string(),
      query: z.string(),
      topic: z.enum(["general", "news", "finance"]).optional(),
      includeDomains: z.array(z.string()),
      reason: z.string(),
    }),
    z.object({
      kind: z.literal("extract"),
      label: z.string(),
      urls: z.array(z.string().url()).max(8),
      reason: z.string(),
    }),
  ])).max(8),
});

const { patch, effect, loop, render } = workflow<
  ResearchState,
  OpenWebIntelligenceConnectorCatalog
>({
  stateSchema: ResearchStateSchema,
  state: initialState,
  invalidation,
});

patch({
  progress: "正在理解调研目标",
  state: {
    status: ResearchStatusSchema,
    researchQuestions: z.array(z.string()),
  },
  instruction: `
Extract one to three durable, self-contained research questions from the latest user message.
Do not extract query plans, candidates, or sources into state.
`,
});

const researchLoop = loop("researchPasses", {
  description: "Plans and executes bounded public-source research passes until evidence is enough or maxRuns is reached.",
  dependsOn: ["researchQuestions"],
  maxRuns: 3,
  stateSchema: ResearchPassStateSchema,
  instruction: `
Read researchQuestions and previous evidence.

Pass 1 should usually discover candidate competitors, source types, or official pages.
Pass 2 should drill into high-value candidates or official evidence pages.
Pass 3 should close evidence gaps, verify conflicts, or stop when marginal value is low.

Set status=satisfied when evidence can support the requested answer.
Set status=blocked when the research object is too broad, ambiguous, or outside supported public-source boundaries.
Never expand beyond the user's requested scope.
`,
});

researchLoop.effect("searchPlannedQueries", ["loop.state"], {
  description: "Runs the current pass search queries; results are candidate sources and remain ToolMessages.",
  run: async (_state, context, runtime, step) => {
    const loopState = runtime.loop.state;
    const searchActions = loopState.actions.filter((action) => action.kind === "search");
    if (searchActions.length === 0) return {};

    const loading = step.start("搜索候选来源", {
      run: runtime.loop.run,
      queryCount: searchActions.length,
    });

    const searches = await Promise.all(
      searchActions.map((action) =>
        context.call("connectors.web.search", toSearchInput(action), {
          cache: true,
        }),
      ),
    );

    loading.end({ resultSets: searches.length });

    return {
      messages: searchMessages(loopState, searches),
    };
  },
});

researchLoop.effect("extractPlannedPages", ["loop.state"], {
  description: "Extracts model-selected high-value pages from current loop state; page bodies remain ToolMessages.",
  run: async (_state, context, runtime, step) => {
    const urls = runtime.loop.state.actions
      .filter((action) => action.kind === "extract")
      .flatMap((action) => action.urls);
    if (urls.length === 0) return {};

    const loading = step.start("抽取高价值页面", {
      run: runtime.loop.run,
      urlCount: urls.length,
    });

    const extracted = await context.call(
      "connectors.web.extractPages",
      {
        urls,
        query: runtime.loop.state.passGoal,
        extractDepth: "basic",
        format: "markdown",
        includeFavicon: true,
      },
      { cache: true },
    );

    loading.end({
      extracted: extracted.results.length,
      failed: extracted.failedResults.length,
    });

    return {
      messages: [
        new ToolMessage({
          name: "connectors.web.extractPages",
          call: { urls, query: runtime.loop.state.passGoal },
          result: extracted,
        }),
      ],
    };
  },
});

effect("markResearchReady", {
  description: "Marks the research turn ready after bounded loop execution.",
  dependsOn: ["loop.researchPasses"],
  run: (_state, _context, runtime) => ({
    status: "ready",
    blocker: hasResearchEvidence(runtime.messages) ? null : "evidence_unavailable",
  }),
});

export default render({
  name: "competitor_market_research_reply",
  progress: "正在生成调研回复",
  instruction: `
Use researchQuestions and all loop ToolMessages.
Explain what was covered, what evidence supports it, what remains uncertain,
and whether the loop stopped because evidence was sufficient, blocked, or maxRuns was reached.
`,
});
```

## Example: Multiple Loops In One Workflow

```ts
const discoveryLoop = loop("discovery", {
  description: "Discovers candidate products.",
  dependsOn: ["need"],
  maxRuns: 2,
  stateSchema: DiscoveryStateSchema,
  instruction: "...",
});

discoveryLoop.effect("searchProducts", ["loop.state"], { ... });
discoveryLoop.effect("enrichProducts", ["searchProducts"], { ... });

const verificationLoop = loop("verification", {
  description: "Verifies selected candidate claims after discovery.",
  dependsOn: ["loop.discovery"],
  maxRuns: 2,
  stateSchema: VerificationStateSchema,
  instruction: "...",
});

verificationLoop.effect("checkClaims", ["loop.state"], { ... });
verificationLoop.effect("loadEvidence", ["checkClaims"], { ... });
```

This keeps both loops explicit without nesting:

- `discovery` owns candidate discovery passes.
- `verification` owns claim verification passes.
- Durable state stores only the user need and selected/committed business facts.
- ToolMessages carry candidate and evidence payloads across loops.

## Definition-Time Validation

`@pac/workflow` should reject:

- duplicate loop names;
- duplicate loop effect names within a loop;
- loop name collision with top-level node names;
- fully qualified loop node name collision with any node;
- `maxRuns` less than `1` or above the v1 maximum of `5`;
- blank loop descriptions, instructions, or effect descriptions;
- missing `stateSchema`;
- loop dependencies that reference unknown loops or invalid state fields;
- loop effect dependencies that reference unknown sibling effects, except `"loop.state"`.

## Engine Execution

Engine execution order:

1. route active workflows;
2. append user message;
3. patch;
4. run prefetch/effect/loop/command scheduler until stable;
5. render.

Loop appears as a node class inside the existing scheduler, not as a second scheduler.

The loop node internally performs:

1. planner structured LLM call;
2. decision validation;
3. loop state ToolMessage append;
4. loop body effect execution;
5. repeat until satisfied, blocked, or maxRuns.

Loop execution emits trace events:

- `node.loop.start`
- `node.loop.state.start`
- `node.loop.state.end`
- `node.loop.run.start`
- loop child `node.step.start/end`
- `node.loop.run.end`
- `node.loop.end`

Trace details should include loop name, run number, max runs, decision status, and stop reason. They must not include secrets or full connector payloads.

## Error Handling

Planner structured output failure:

- default: fail the loop node and roll back the turn like other node failures;
- future option: `onPlannerError: "fail" | "stop-blocked"` if use cases need graceful degradation.

Connector failure:

- author may catch connector errors inside loop effects and emit error ToolMessages;
- uncaught failures behave like existing effect failures.

Max runs reached:

- loop stops with status `max_runs`;
- render must explain that the bounded research budget was exhausted if relevant.

Blocked:

- planner returns `blocked` when the next pass would require user clarification, unsafe expansion, or unsupported sources;
- render asks the needed clarification or explains the boundary.

## Security And Side Effects

Loop body effects are still effects. They must be idempotent and should only perform read-only connector calls.

Irreversible operations must remain commands. A command should not run multiple times inside a loop. If a future use case needs repeated external mutations, it requires a separate RFC.

Loop planner must not receive connector credentials, raw secrets, or non-public runtime internals.

## Backward Compatibility

This is additive:

- existing workflows using `patch/effect/command/render` continue to work;
- `derive` remains a migration alias for `effect`;
- existing effect dependency semantics are unchanged outside loops;
- no existing public type needs to be removed.

## Migration Strategy

1. Add definition types and definition-time validation in `@pac/workflow`.
2. Add loop node runtime representation in `@pac/workflow` definitions.
3. Add engine scheduler support for loop nodes.
4. Add loop trace events.
5. Add unit tests for definition validation, maxRuns, planner decisions, loop child effects, state patches, rollback, and multiple loop dependencies.
6. Update `docs/API.md` after implementation.
7. Update `pac-workflow-creator` skill to prefer loop only when the procedure requires bounded multi-pass reasoning.

## V1 Decisions

1. Do not add `loop.finalize(...)`, `resultSchema`, or separate loop result APIs in v1.
2. `maxRuns` is required. The package-level definition cap is `5` in v1; engine policy may lower it for hosted runtimes but cannot raise it without a package change.
3. Loop state ToolMessages are visible to render and later runs in the same workflow execution. Patch prompts should not treat prior loop states as user-authored business facts.
4. Loop effect dependencies support `"loop.state"` and sibling loop effect names in v1. A special `"loop.messages"` dependency is deferred until there is a concrete need.
5. Planner `blocked` decisions use `reason` in v1. A structured `questions` field can be added later if render cannot reliably ask concise follow-up questions from `reason`.
6. Loop body effects may return durable state patches. Use this for compact handoff state only; keep evidence-heavy data in ToolMessages.

## Remaining Questions

1. Should loop planner ToolMessages be persisted across future user turns exactly like connector ToolMessages, or should the engine mark them as current-turn-only evidence?
2. Should multiple independent loops remain declaration-order only, or should a future engine mode permit concurrent execution when a workflow declares the loops as isolated?

## Recommendation

Implement generic workflow loop as a first-class program primitive:

```ts
const loop1 = loop("name", {
  description: "...",
  dependsOn: ["stateField"],
  maxRuns: 3,
  stateSchema,
  instruction: "...",
});

loop1.effect("effectName", ["loop.state"], { ... });
```

This keeps authoring flat, supports multiple loops, avoids business-specific loop APIs, and preserves the key boundary: durable workflow state stores user-authorized business facts, while loop runtime owns pass control and ToolMessages carry evidence.
