---
name: pac-procedure-writer
description: "Write or revise PAC scenario procedure.md files as business-facing procedure documents. Use when Codex needs to create, clean up, review, or normalize a PAC procedure from a business scenario, especially before workflow implementation. This skill keeps procedure.md focused on business rules, user situations, connector/tool usage timing, side-effect boundaries, and response obligations; it explicitly excludes workflow state, schemas, patch/prefetch/derive/command/render implementation details, ToolMessage details, and invalidation tables."
---

# PAC Procedure Writer

Use this skill only for `procedure.md` authoring or review. A PAC procedure is a business document: it tells a business person what the flow does, when tools are used, what must be confirmed, what side effects are allowed, and what the assistant must or must not say.

Do not design workflow state in `procedure.md`. State-first design belongs in the workflow implementation phase, not in the procedure document.

## First Reads

Before writing or editing a procedure:

- Read the repository `AGENTS.md`.
- Read nearby `procedure.md` examples, especially `scenarios/maintenance/procedure.md`.
- Read available `connectors.ts` only to learn connector names, capabilities, inputs, outputs, and side-effect boundaries.
- Read the user's business scenario or source procedure.

Use existing workflow files only to understand local naming conventions. Do not copy implementation language into procedure text.

## Procedure Contract

`procedure.md` should include:

- Business purpose and scope.
- User situations that enter the flow.
- Minimum information the user must provide.
- System information or external facts the flow should read.
- Connector/tool calls and when each one is used.
- User confirmation points.
- External side effects and the exact condition for triggering them.
- What to do when information changes.
- What to do when data is missing or a tool fails.
- Response obligations and compliance/safety boundaries.
- Explicitly unsupported behaviors or neighboring procedures.

`procedure.md` must not include:

- Workflow state fields, state tables, state defaults, or state writer ownership.
- Zod schemas, TypeScript type names, code structure, or file layout.
- Patch, prefetch, derive, command, render, ToolMessage, context, cache key, runtime message, or invalidation implementation terms.
- LLM prompt instructions that only make sense to a developer.
- Test internals, fake patches, or engine mechanics.

## Style

Match the concise prose style of `scenarios/maintenance/procedure.md`:

- Write in Chinese when the scenario is Chinese.
- Use short paragraphs.
- Prefer business language over architecture language.
- Reference connectors inline with `{@connectors.namespace.toolName}`.
- Say "通过 {@connectors.xxx} ..." when describing a tool call.
- Say "必须/不能/只有当..." for hard business rules.
- Keep implementation detail out even when it is obvious how the workflow will implement it.

Good:

```markdown
当用户给出金额和用途后，通过 {@connectors.presales.matchProducts} 匹配候选产品。系统应说明匹配原因、关键门槛和不确定性，不能把候选产品说成已经获批。
```

Bad:

```markdown
Patch 写 requestedAmountCents 和 useCase，derive 调 matchProducts，并把 ProductMatch 放入 ToolMessage；requestedAmountCents invalidates selectedProduct。
```

## Recommended Shape

Use this shape unless the existing scenario clearly uses another one:

```markdown
# <业务名> Procedure

<一段说明本流程覆盖什么、目标是什么、边界是什么。>

<按业务推进顺序描述：用户先说什么，系统先读取什么工具，什么信息是必要的，缺失时怎么问。>

<描述候选查询、用户确认、草稿或只读分析等关键分支。>

<描述不可逆外部动作的触发条件；如果没有外部写操作，明确说明本流程只读。>

## 必须覆盖的业务分支

1. ...

## 明确不支持的行为

...
```

For tool-heavy research procedures, use:

```markdown
## 可用工具边界

- `工具名`：业务能力说明。

## 通用资料收集规则

- 某类问题优先使用哪些工具。

## 子场景

### scenario_id

触发：...
工具调用：...
回复口径：...
```

This is still business-facing because it describes user situations and tool policy, not workflow implementation.

## Writing Workflow

1. Identify the business owner view: what the user asks, what the assistant must know, what external systems can answer, and what actions are safe.
2. List available connectors by business capability, not by TypeScript schema.
3. Write the happy path in business order.
4. Add branches for missing information, user changes, cancellations, tool failures, and unsupported requests.
5. Add confirmation and side-effect rules.
6. Add response boundaries: what may be claimed, what must be caveated, and what must not be said.
7. Scan the result for forbidden implementation terms and remove them.

## Connector References

Use connector references only when the procedure intentionally requires that business tool:

- Good: `通过 {@connectors.maintenance.getAvailableSlots} 查询门店可预约时段。`
- Good: `只有用户明确确认预约草稿后，才通过 {@connectors.maintenance.confirmBooking} 提交正式预约。`
- Bad: `derive("appointmentAvailability") 调用 getAvailableSlots。`

When the connector namespace is not finalized, describe the tool capability in business words and mark the uncertainty plainly. Do not invent connector ids.

## Review Checklist

Before finishing a procedure, verify:

- A business stakeholder can read it without knowing PAC runtime terms.
- Every connector reference has a business reason and a trigger condition.
- Every external write has an explicit user confirmation or business trigger.
- Missing information and unsupported requests are handled.
- Response boundaries are stated for regulated or high-risk domains.
- No state table, schema, patch/prefetch/derive/command/render, ToolMessage, context, cache, or invalidation language remains.
