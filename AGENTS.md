# AGENTS.md

本文件适用于整个仓库。每次开始编码、改测试、改文档或调整工作流产物前，必须先阅读本文件，并结合要改动区域的 README、API 文档、源码和测试确认真实边界。

## 项目定位

PAC 是一个 TypeScript ESM monorepo，用来把自然语言业务 procedure 编译为可执行的 dynamic workflow，并通过 runtime engine 执行。核心思想是：

- `@pac/workflow` 定义 workflow DSL、Zod schema、connector contract、runtime types 和 workflow artifact 的定义期校验。
- `@pac/engine` 负责 workflow 路由、session、runtime instance、patch/render LLM 调用、connector 注入、消息历史、invalidation、node 调度、CLI 和 trace。
- `scenarios/**` 是业务 workflow 示例与验证材料，不是稳定公共 API。
- `pac-dynamic-workflow/`、`pac-workflow-creator/`、`pac-workflow-testing/` 是 Codex skill 包，描述如何生成和验证 PAC workflow。

这个仓库目前是实验性 runtime 和 scenario workspace，正在向可发布的开源项目整理。不要把它当作已经稳定的 1.0 API 或生产服务。

## 本地环境与命令

使用 Node.js `>=24.0.0` 和 npm `11.12.1`。仓库使用 npm workspaces，包管理器以根 `package.json` 为准。

常用命令：

- `npm ci`：安装依赖。
- `npm run check`：TypeScript 类型检查。
- `npm run build`：构建 `@pac/workflow` 和 `@pac/engine`。
- `npm run test:unit`：运行 `packages/*/src/**/*.unit.test.ts`。
- `npm test`：类型检查、构建、单元测试。
- `npm run pack:check`：构建并 dry-run 检查包内容。
- `npm run audit:check`：高危依赖审计。
- `npm run ci`：默认本地质量门禁。
- `npm run scenario:maintenance`：运行 maintenance 示例场景，依赖真实 LLM 配置。
- `npm run test:llm`：手动 LLM smoke test，可能调用真实模型，不属于默认门禁。

`.env` 只用于本地 OpenAI-compatible provider 配置，参考 `.env.example`。不要提交真实密钥或本地环境文件。

## 编码前置要求

- 先查清楚接口来源、调用方向、输入输出、运行时 owner 和副作用边界，再改代码。
- 优先复用现有 public helpers、schema guards、runtime utilities 和测试 fixture。不要为了当前改动临时造第二套 API、第二套路由、第二套状态管理。
- 修改保持外科手术式：只改本次需求需要的文件和行为，不顺手重排、重命名或格式化无关代码。
- 若业务规则、connector 行为、发布策略或安全策略不明确，先把不确定性显式提出；不要在代码里悄悄补业务假设。
- public surface、CLI 行为、workflow authoring 规则或 setup 命令变化时，同步更新 `README.md`、`docs/API.md`、包级 README 或相关 skill 文档。

## TypeScript 与文件风格

- 项目使用 `"type": "module"`、`moduleResolution: "NodeNext"`。本地相对导入必须写运行时 `.js` 后缀，例如 `./runtime/context.js`。
- 保持 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns` 等约束通过。
- 使用 Zod 作为运行时边界。动态输入、connector 输入输出、workflow metadata、LLM request/response、CLI module exports 都应通过 schema 或既有 guard 校验。
- 不使用 `any` 绕过类型系统。必须收窄未知值时，优先新增局部 schema/guard，并把错误信息写清楚。
- 多词 helper 文件沿用 kebab-case，例如 `schema-boundary.ts`、`node-runner.ts`。
- 单元测试放在实现旁边，命名为 `*.unit.test.ts`，使用 `node:test` 和 `node:assert/strict`。
- 方法、导出的 helper、边界函数和复杂业务逻辑需要有简洁注释，说明用途、输入、输出、边界条件和关键副作用。注释解释为什么这样做，不复述代码本身。

## 包边界

### `packages/workflow`

- 这里是 workflow authoring 和 contract 层。保持 root exports 稳定，新增公共 API 前先确认 `docs/API.md` 和包 README 是否需要更新。
- 定义期校验放在 `src/definition/**`，runtime KV、prefetch、messages 等放在 `src/runtime/**`，通用 schema/helper 放在 `src/utils/**`。
- `messages` 是 runtime 保留字段，workflow state schema、default state、patch state 都不得声明或覆盖它。
- connector contract 必须通过 `defineConnectorRef`、`defineConnectorCatalog`、`defineConnectorTool` 和 `createConnectorRegistry`，输入输出由 Zod schema 解析。

### `packages/engine`

- engine 拥有调度、session、routing、runtime message history、patch extraction、render、invalidation、trace、CLI 动态加载和 LLM provider 边界。
- local unit tests 使用 fake `LlmClient`。不要在单元测试里调用真实模型或真实外部服务。
- `runtime/**` 放运行时执行、mutation、实例、tracer、renderer；`llm/**` 放 provider/request boundary；`cli/**` 放 CLI 解析和动态模块加载；`utils/**` 放共享辅助逻辑。
- 模型调用返回 workflow patch structured output 失败时，严禁在 engine、LLM client、CLI 或 scenario runner 里添加针对 patch 的重试逻辑；应修正 workflow patch schema、Zod 边界或 patch/render instructions，让一次结构化调用本身可解释、可校验。
- engine 应继续防御非序列化诊断值、重复 workflow id、未知 active workflow、无效 default state、无效 render response 和保留字段写入。

### `scenarios`

- 每个业务 scenario 通常包含 `procedure.md`、`workflow.yaml`、`*.workflow.ts`、`connectors.ts`、`mockData.ts` 和可选 runner。
- `workflow.yaml` 存稳定 metadata、routing 和验收 cases。`*.workflow.ts` 是可分发 workflow artifact。
- 示例代码可以服务演示和验证，但不要从示例反向发明新业务规则；新业务规则必须来自对应 procedure。

## Workflow 编写规则

写或改 PAC workflow 时，先读对应 `procedure.md`。procedure 是业务事实来源，`workflow.yaml`、workflow 文件、connector、mock data 和测试都应从它编译出来。

工作流文件应使用现有 program DSL：

1. `const { patch, prefetch, effect, command, render } = workflow<State, ConnectorCatalog>({...})`
2. 先声明 `patch(...)`
3. 再声明 `prefetch(...)`
4. 再声明 `effect(...)`
5. 再声明 `command(...)`
6. 最后 `export default render(...)`

具体约束：

- `patch` 只提取最新用户消息直接表达的结构化事实，不能调用 connector，不能生成最终回复，不能发明 records、ids、价格、库存、时段或可用性。
- 如果 patch structured output 失败，不通过 retry、fallback retry、二次模型调用或静默重跑修补；必须回到 workflow 的 patch schema、字段设计、nullable/optional 边界和 instruction 本身优化。
- `prefetch` 只做 baseline read-only 数据读取，通常按 `session.userId` 等 stable key 缓存。
- `effect` 用于幂等的业务推导、候选读取、默认选择、草稿准备。它可以返回 partial state，也可以通过 `messages: [new ToolMessage(...)]` 暴露 connector facts；优先用 `dependsOn` 声明驱动该 effect 的 state 字段依赖。`effect` 不写 `when`，业务条件放在 `run` 开头判断；不依赖 `preState`；加载展示用 `step.start(...)` / `step.end(...)`。
- `command` 只放不可逆或外部 mutating 动作，例如正式提交、取消、支付。必须由明确 state evidence 触发，不能只凭模糊文本运行。
- `render` 是唯一用户可见输出路径。render 不改 state，不调 connector，不返回 JSON/type/kind/decision 标签，只声明 name/progress/instruction。
- connector 调用必须通过 `context.call("connectors.xxx", input)`；幂等读取如果需要在同一 workflow context 内复用，优先用第三参数 `context.call("connectors.xxx", input, { cache: true })`，默认缓存键是 connector id 加 `JSON.stringify(input)`；只有需要自定义复用边界时才写 `cacheKey`。workflow 文件只能 import connector catalog type，不能 import mock data、service function、connector tool 或 LLM client。
- 业务真相放在 schema-validated `state`；本轮候选、缓存 key、临时对象放在 runtime `context` 或 tool messages。
- 上游字段变化必须用 invalidation 清理下游 stale state。已提交的 booking/order/application 等 committed record 不应被普通偏好变更自动清掉，除非 procedure 明确要求。
- 不写本地 regex/text classifier 来判断业务意图。需要上下文解析时，让 patch 抽取用户表达，再用 workflow node 结合 state/context 解析。
- 每个 `prefetch`、`effect`、`command` 都要有说明清楚业务目的、输入、输出、副作用边界的 `description`。`prefetch` 仍需要短 `progress`；`effect` 和 `command` 的加载步骤优先通过 `step` 发出。

## 测试与验证策略

- TypeScript 或 runtime 行为改动后，至少运行 `npm run check` 和相关 `npm run test:unit`。共享行为、public API、engine/workflow 边界改动后运行 `npm test`，合入前优先跑 `npm run ci`。
- 新增或修改 public package 输出时，运行 `npm run pack:check` 并检查 `files`、`exports`、README 和类型声明是否一致。
- workflow/scenario 改动优先补确定性 runtime 测试：fake structured LLM、固定时钟、mock connector、断言运行完成后的业务 state、context、tool messages 和 command side effects。
- 严禁编写任何对 workflow 的 state patch 中间产物做断言的测试：不要断言 `statePatch` / `MessagePatch.statePatch` 的字段、结构、顺序、内容或快照。测试只能把 fake patch 当作输入驱动运行时路径，断言 patch 被 engine 应用后的业务结果和副作用。
- `npm run scenario:maintenance` 和 `npm run test:llm` 依赖真实 LLM，适合手动 smoke test。运行或跳过都要在最终说明中讲清楚原因。
- connector failure、缺失数据、上游改动 invalidation、用户追问不触发 command、command 失败不写 committed record，都是 workflow 测试的重点。

## 发布与安全

- 目前仓库没有 `LICENSE`，不要发布包或宣称正式开源发布，除非维护者先完成 license 决策并更新 package metadata。
- 不提交 `packages/*/dist` 生成物，除非维护者明确要求。
- 不提交真实 `.env`、token、API key、模型服务地址或私有用户数据。
- 安全问题按 `SECURITY.md`，支持渠道按 `SUPPORT.md`，发布步骤按 `RELEASING.md`。

## 变更完成标准

- 改动与当前需求直接相关，没有无关重构或格式噪音。
- 相关包边界、schema 边界、runtime owner 和副作用边界清楚。
- 必要测试已补充并运行；无法运行的命令要说明原因。
- 相关 README、`docs/API.md`、scenario procedure、workflow metadata 或 skill 文档已同步。
- 最终回复列明改了什么、验证了什么，以及任何剩余风险。
