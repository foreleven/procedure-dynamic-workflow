---
name: pac-workflow-testing
description: PAC workflow goal-driven scenario testing with formal-user simulation. Use when Codex needs to debug or test a workflow through CLI/engine by setting a user goal, generating one send+expected turn at a time, preserving a live session, evaluating actual replies/state/traces, scoring the scenario, and saving a reviewable transcript file without prewritten scripts or statePatch assertions.
---

# PAC Workflow Testing

用于测试 PAC workflow 的真实多轮交互表现。默认测试方式是“设定目标 -> 每轮生成 `send + expected` -> 真实发送 -> 评估本轮结果 -> 再决定下一轮”，不是把整段剧本提前写死。

## 核心原则

- 只设定本轮测试的用户目标，例如“完成一次保养预约”“草稿前改时间”“草稿后追问保养项目”“中途取消”。
- 每一轮只生成下一条用户消息 `send` 和本轮预期 `expected`。下一轮必须基于实际 assistant 回复、compact state、trace 和 transcript 再生成。
- 必须走真实 workflow runtime：真实 patch extraction、真实 render、真实 connector registry、真实 session state。
- 不准预写完整多轮剧本。
- 不准构造、排队、断言或检查 `statePatch` / `MessagePatch.statePatch`。
- 不用硬断言中断场景测试；记录 evaluator verdict、bug signals、runtime error 和 transcript，让测试能继续暴露更多问题。
- 测试结束必须给场景打 0-100 分，并把完整过程写入 review 文件，供用户后续审阅。

## 准备输入

开始前确认这些信息：

- workflow 文件路径，例如 `agents/maintenance/workflows/maintenance_booking.workflow.ts`
- connector 文件路径，例如 `agents/maintenance/connectors/main.ts`
- user id，例如 `user_feng`、`user_alex`
- session id；如果没有，先生成一个，例如 `maintenance_test_${Date.now()}`
- 测试目标 goal，用一句话描述用户最终想达成什么
- turn budget，例如最多 8 轮
- review 输出目录；如果用户未指定，默认写到 `agents/<scenario-name>/test-reports/`

注意：当前 CLI session 是进程内存态。要保留上下文，必须在同一个 CLI/runner 进程里连续发送多轮；重启进程后仅复用 session id 不会恢复历史状态。

## 标准流程

1. 启动真实 workflow runtime。根据测试输入选择一种方式：
   - 如果已有 `agent.yaml` cases，优先直接用 CLI 执行，例如 `npm run chat -- agents/<name> --all-cases --no-stream` 或 `npm run chat -- agents/<name> --case <id> --no-stream`。CLI 输出是本次 review 的事实来源。
   - 如果是探索式多轮目标、需要动态生成下一轮用户消息、或需要保留同一 live session 的复杂状态，才考虑直接使用 `WorkflowEngine` 写临时 runner。
   - 手工 CLI 调试可用 `npm run chat:maintenance -- --session-id <id> --no-stream`。
2. 生成或读取本轮用户消息：
   - 对 `agent.yaml` cases，直接读取每个 turn 的 `message` 和 `expect.responseSatisfies`，不要再另写脚本改写输入。
   - 对探索式目标，给“用户模拟器”这些输入：
   - goal
   - user id
   - turn index / max turns
   - 上一轮 assistant 回复
   - compact state
   - 已发生 transcript
3. 探索式目标中，用户模拟器只输出本轮：
   ```json
   {
     "send": "1",
     "expected": "系统应识别用户选择了第一家门店，并展示可预约时段，不能创建草稿或提交预约。",
     "stop": false
   }
   ```
4. 把 `send` 真实发给 workflow；如果使用 CLI all-cases，则每个 manifest turn 已由 CLI 真实发送。
5. 记录本轮实际结果；如果使用 CLI all-cases，至少从 CLI 输出中记录 case id、user message、expected、assistant reply、response workflow ids、runtime error 和耗时：
   - assistant reply
   - compact state（CLI 没有输出 state 时，明确写 `not captured by CLI`，不要伪造）
   - trace phases（CLI 未启用 `--traces` 时，明确写 `not captured by CLI`）
   - runtime error
   - turn total duration；从真实发送 `send` 前开始计时，到 evaluator verdict 和本轮 transcript 记录完成为止
6. 用“本轮评估器”比较 `expected` 和实际结果，输出：
   ```json
   {
     "verdict": "pass | warn | fail",
     "reason": "简短说明",
     "bugSignals": ["confirmation_after_draft_did_not_commit"]
   }
   ```
7. 把本轮追加进 transcript，再进入下一轮。不要回头改上一轮，也不要提前补全后续剧本。
8. 测试结束后为整个场景计算评分，生成 review 文件，并在最终回复里给出文件路径。CLI all-cases 也必须落 review 文件，不能只在对话里总结。

## 用户模拟器要求

用户模拟器负责生成“真实用户下一句话”，不是测试脚本。

- 只输出当前轮的 `send` 和 `expected`。
- `send` 要像真实用户：可以短句、序号、改口、追问、确认、取消。
- `expected` 写业务层预期，不写内部实现细节。
- 如果助手列选项，可以回复“1”“第一个”“就这个”“还是上次那家”。
- 如果目标是改时间，不要提前规划整条路径；等实际出现草稿或时间选择后再自然改口。
- 如果目标已完成或取消，输出 `stop: true`。

好的 `expected` 示例：

- `系统应要求用户选择车辆，不能猜测多车用户要预约哪一辆。`
- `系统应展示门店候选项，不能直接选择最近门店。`
- `系统应生成待确认草稿，但不能表示预约已经成功。`
- `系统应正式提交预约并给出成功信息。`

不好的 `expected` 示例：

- `statePatch.dealer 应该等于 dealer_hoboken_bmw`
- `下一轮我要说 1，然后再说确认`
- `断言 patch 里必须有 preferredDate`

## 评估器要求

评估器只判断当前轮 `expected` 是否被真实结果满足。

- 可以看 assistant reply、compact state 和 trace phases。
- 不看、不构造、不评价 `statePatch`。
- `pass`：满足当前轮预期。
- `warn`：可以继续，但有歧义、遗漏或体验问题。
- `fail`：明显错误推进、错误提交、该确认没确认、该取消没取消、运行时报错或回复与 state 矛盾。

常见 bug signals：

- `runtime_error`
- `asked_wrong_next_action`
- `claimed_success_without_booking`
- `confirmation_after_draft_did_not_commit`
- `created_draft_too_early`
- `committed_without_explicit_confirmation`
- `cancelled_but_status_not_cancelled`
- `stale_draft_after_time_change`

## 场景评分

每次完整测试结束后输出一个 `score`，范围 0-100。评分用于用户 review，不作为硬断言。

推荐评分结构：

- 目标完成度 40 分：目标达成且终态合理给满分；目标部分推进但未完成给 10-30；跑偏或无法继续给 0-10。
- 逐轮预期满足度 30 分：`pass` 轮次占比折算；`warn` 按半分计算；`fail` 不计分。
- 业务边界安全 20 分：没有提前创建草稿、没有未确认提交、没有成功话术与 state 矛盾、取消/改时间后无 stale state。
- 对话体验 10 分：回复清楚、下一步明确、能处理追问或改口、没有无意义循环。

严重问题扣分建议：

- runtime error：至少扣 30。
- 未明确确认就提交正式预约：至少扣 40。
- assistant 声称成功但 compact state 没有 committed record：至少扣 30。
- 用户取消后仍推进预约：至少扣 25。
- 改时间后沿用旧草稿或旧时段：至少扣 20。
- 连续两轮无法给出正确下一步：扣 10-20。

评分输出示例：

```json
{
  "score": 72,
  "grade": "needs_review",
  "reason": "目标推进到草稿，但确认后未正式提交；其余轮次可继续。",
  "passTurns": 4,
  "warnTurns": 1,
  "failTurns": 1,
  "bugSignals": ["confirmation_after_draft_did_not_commit"]
}
```

`grade` 建议使用：

- `pass`：85-100
- `needs_review`：60-84
- `fail`：0-59

## 耗时统计

每一轮必须记录总耗时，并写入 review 文件。总耗时的边界是：开始真实发送本轮 `send` 前计时，直到本轮 evaluator verdict、bug signals、runtime error 和 transcript 都记录完成后停止计时。这个值覆盖 workflow runtime、connector、LLM render、评估器和本轮记录开销。

建议字段：

- `durationMs`：本轮总耗时，毫秒整数。
- `durationText`：面向人读的耗时，例如 `12.34s`。
- 可选细分字段：`engineDurationMs`、`evaluationDurationMs`、`reportingDurationMs`。只有在 runner 已经自然具备这些边界时才记录，不要为了细分耗时改动 workflow 行为。

Summary 中必须加入耗时分布总计，至少包含：

- `totalDurationMs` / `totalDurationText`：所有 turn 的总耗时。
- `turnCount`：参与统计的轮次数。
- `minDurationMs`、`maxDurationMs`、`avgDurationMs`。
- `p50DurationMs`、`p90DurationMs`；轮次太少时按已有样本计算。
- 可选按 verdict 汇总：`passTotalDurationMs`、`warnTotalDurationMs`、`failTotalDurationMs`。

## Compact State

场景 transcript 里只记录调试需要的 compact state，避免输出整段 message history：

```json
{
  "status": "collecting",
  "vehicle": "veh_bmw_x3",
  "dealer": "dealer_hoboken_bmw",
  "preferredDate": "明天下午",
  "slot": null,
  "bookingDraft": null,
  "booking": null,
  "messageCount": 6
}
```

## Review 文件

每次测试运行必须保存一个 review 文件。用户没有指定目录时，默认写入：

```text
agents/<scenario-name>/test-reports/<YYYYMMDD-HHmmss>_<session-id>.md
```

如果测试不属于某个 `agents/<name>` 目录，写入：

```text
workflow-test-reports/<workflow-id>/<YYYYMMDD-HHmmss>_<session-id>.md
```

目录不存在时创建目录。一个测试 run 对应一个文件；多 run 时每个 run 单独成文件，或在文件名里追加 `run-<n>`。

Review 文件必须包含：

```text
SESSION maintenance_test_1781370222019
WORKFLOW maintenance_booking@1.0.0
GOAL 完成一次保养预约，直到正式预约成功
USER user_feng
SCORE 72/100 needs_review
SUMMARY 目标推进到草稿，但确认后未正式提交。
DURATION total=84.21s turns=6 min=8.10s max=18.44s avg=14.04s p50=13.88s p90=18.44s

TURN 1
SEND: 我想预约保养，明天下午
EXPECTED: 系统应确认单车用户车辆并要求选择门店，不能直接创建草稿。
ACTUAL: ...
STATE: {"status":"collecting","vehicle":"veh_bmw_x3","dealer":null,...}
TRACES: routing.active, node.withPatch.customerProfile, patch, node.afterPatch.dealerCandidates, render
DURATION: 12.34s
VERDICT: pass

TURN 2
SEND: 1
EXPECTED: 系统应识别第一家门店并展示可预约时段。
...
```

建议文件结构：

````markdown
# Workflow Scenario Test Report

- Session: ...
- Workflow: ...
- User: ...
- Goal: ...
- Score: 72/100
- Grade: needs_review
- Model: ...
- Started at: ...
- Finished at: ...

## Summary

...

- Total duration: 84.21s
- Turn duration distribution: count 6, min 8.10s, max 18.44s, avg 14.04s, p50 13.88s, p90 18.44s

## Score Breakdown

...

## Transcript

### Turn 1

- Send: ...
- Expected: ...
- Actual: ...
- Verdict: pass
- Duration: 12.34s
- Bug signals: []
- State:
  ```json
  {}
  ```
- Traces: ...

## Final State

```json
{}
```

## Reviewer Notes

留空，供用户 review 时填写。
````

如果发现 bug，最终回复必须包含 review 文件路径、score、grade、主要 bug signals 和复现用 session id / user id / goal。

## 适用边界

这种测试用于“正式用户多轮随机/探索场景”的黑盒或灰盒验证。它不能替代 engine unit test，也不用于证明每条业务分支 100% 覆盖。需要固定业务不变量时，另写 runtime 单元测试，但仍不要断言 `statePatch` 中间产物。
