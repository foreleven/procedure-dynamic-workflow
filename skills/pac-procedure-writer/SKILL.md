---
name: pac-procedure-writer
description: "Write or revise PAC procedure files under an agent's procedures/ directory as business-facing documents from user-provided scenario input and existing connector contracts. Use when Codex needs to create, clean up, review, or normalize a PAC procedure that describes user situations, connector usage timing, confirmation requirements, external write boundaries, failure handling, unsupported behavior, and response obligations. Do not use implementation files, internal execution concepts, generated code structure, tests, or mock data as business sources."
---

# PAC Procedure Writer

Use this skill only for authoring or reviewing PAC procedure Markdown files under an agent's `procedures/` directory. A PAC procedure is a business document: it tells a business person what the assistant should handle, what existing connectors may be used, when user confirmation is required, what external writes are allowed, and what the assistant must or must not say.

The procedure writer has only these business sources:

- The user's scenario, notes, or existing source procedure.
- The target file under `procedures/` when revising an existing procedure.
- Existing connector contracts and connector files, used only to learn available connector ids, capabilities, inputs, outputs, and read/write boundaries.

Do not read or rely on implementation modules, generated artifacts, tests, mock data, or internal execution terminology. Do not invent connectors. If a needed external capability has no existing connector, ask the user whether to omit that capability, describe it as a manual/non-connector step, or wait for a connector to be added.

## Target Location

Procedure files must live under the target agent's `procedures/` directory.

- When creating a new procedure, write `procedures/<kebab-case-procedure-id>.md`.
- When revising, edit the existing file under `procedures/`; do not move or rename it unless the user requests it or the filename clearly conflicts with the procedure id.
- Do not create or update a root-level `procedure.md` for new procedure authoring.
- If an older agent still has a root-level `procedure.md`, treat it only as legacy source material when the user explicitly asks to migrate or revise it.

## First Reads

Before writing or editing a procedure:

- Follow repository-level instructions that apply to file edits.
- Read the user's scenario or source procedure.
- Read the target file under `procedures/` if it already exists.
- For multi-procedure agents, inspect the filenames and frontmatter of other files in `procedures/` only as needed to avoid duplicate ids, duplicate business scopes, or inconsistent connector references.
- Read only the connector files needed for the scenario. Treat connector ids and contracts as available tools, not as business requirements.

Existing procedures may be checked only for local prose style when the user asks for style consistency. They are not a source of new business facts.

## Procedure Frontmatter

Every produced procedure file must start with YAML frontmatter:

```markdown
---
id: "<kebab-case-procedure-id>"
title: "<business title>"
description: "<one-sentence business scope>"
language: "zh-CN"
connectors:
  - "connectors.namespace.toolName"
external_writes:
  - "connectors.namespace.mutatingToolName"
---
```

Rules:

- Use `language` that matches the procedure body.
- List only existing connector ids that the body actually references.
- Put read-only and mutating connectors together in `connectors`.
- Put only externally mutating connectors in `external_writes`; use `[]` when the procedure is read-only.
- Keep metadata factual and short. Do not put implementation terms, file paths, test names, or unconfirmed future connectors in frontmatter.

## Procedure Contract

A procedure file should include:

- Business purpose and scope.
- User situations that enter the procedure.
- Minimum information the user must provide.
- External facts the assistant may read through existing connectors.
- Connector calls and when each one is allowed.
- User confirmation points.
- External writes and exact trigger conditions.
- What to do when user information changes.
- What to do when connector data is missing, empty, or unavailable.
- Response obligations, compliance limits, and safety boundaries.
- Explicitly unsupported neighboring requests.

A procedure file must not include:

- Internal execution concepts, internal data tables, data extraction plans, prompt snippets, code schemas, file layout, generated artifacts, test internals, fake data, or engine mechanics.
- Connector ids that do not exist.
- Business rules copied from examples unless they are present in the user's input or required by an existing connector contract.

## Style

Write in business prose:

- Use Chinese when the scenario is Chinese.
- Use short paragraphs.
- Prefer business language over technical architecture.
- Reference connectors inline with `{@connectors.namespace.toolName}`.
- Say `通过 {@connectors.xxx} ...` when describing a connector call.
- Say `必须`、`不能`、`只有当...才...` for hard rules.
- Make read-only steps, confirmation steps, and external write steps easy to distinguish.
- Write user-facing prompts and response obligations in a professional service tone: specific, grounded, concise, and domain-aware.
- Avoid generic phrasing such as "ask for more information" or "handle the error"; state exactly what the assistant should ask, why it matters, and what it can do next.

Good:

```markdown
当用户给出金额和用途后，通过 {@connectors.presales.matchProducts} 匹配候选产品。系统应说明匹配原因、关键门槛和不确定性，不能把候选产品说成已经获批。
```

Bad:

```markdown
调用产品匹配模块后把结果保存到内部字段，再由下一阶段渲染候选卡片。
```

## Output Template Requirements

Every new procedure should use this content template unless the user gives a stronger domain-specific structure:

```markdown
---
id: "<kebab-case-procedure-id>"
title: "<业务标题> Procedure"
description: "<一句话业务范围>"
language: "zh-CN"
connectors:
  - "connectors.namespace.toolName"
external_writes: []
---

# <业务标题> Procedure

<业务目的、覆盖范围、只读/写入边界，以及不能承诺什么。>

## 进入场景

<列出哪些用户请求进入本 procedure，哪些相邻请求不应进入。>

## 最小信息

<列出必须由用户提供的信息；说明缺失时应如何专业追问。>

## 可用 connector 边界

- `{@connectors.namespace.toolName}`：<业务能力、允许调用时机、只读/写入边界。>

## 业务推进规则

<按业务顺序说明读取资料、候选生成、确认、外部写入或只读分析的规则。>

## 必须覆盖的业务分支

### <scenario_id>

触发：<用户说法或业务条件。>
connector 使用：<允许使用哪些 connector，以及何时使用。>
回复口径：<必须说明什么、不能声称什么、需要哪些 caveat。>

## 用户确认点

<说明哪些动作前必须确认，确认内容必须包含对象、动作、影响和后果。>

## 用户信息变化

<说明用户修改关键条件时，哪些结论、候选或草稿需要重新确认或失效。>

## 缺失、为空或不可用

<说明 connector 返回空、失败、资料不足或不可访问时的处理方式和用户提示口径。>

## 回复义务和边界

<说明输出必须包含的事实、来源、限制、风险提示、合规边界和不得承诺事项。>

## 明确不支持的行为

<列出不属于本 procedure 的请求和应如何转向。>
```

Professional content requirements:

- Missing-information prompts must name the missing field and explain why it is needed. Prefer one focused question; use at most three short questions when scope is genuinely ambiguous.
- Confirmation prompts must restate the concrete object, selected option, external action, and consequence. Do not ask vague confirmations such as "是否继续" when a business action is at stake.
- Failure or empty-result prompts must be factual and operational: say what was unavailable, what was already tried when known, and what narrower fallback or manual input can move the case forward.
- Regulated, financial, medical, legal, security, or high-stakes procedures must include explicit limits on advice, evidence freshness, source reliability, and human review.
- Output obligations should describe user-visible answers, not internal prompts, chain-of-thought, model instructions, or execution mechanics.

## Template Variants

Use the full output template by default. For very small procedures, sections may be condensed, but the document must still cover entry conditions, minimum information, connector boundaries, confirmation or write rules, missing/failure handling, response obligations, and unsupported behavior.

For connector-heavy research procedures, use:

```markdown
## 可用 connector 边界

- `{@connectors.namespace.toolName}`：业务能力说明。

## 通用资料收集规则

- 某类问题优先使用哪些 connector。

## 子场景

### scenario_id

触发：...
connector 使用：...
回复口径：...
```

## Writing Process

1. Identify the business owner view: what the user asks, what the assistant must know, what existing connectors can answer, and what actions are externally mutating.
2. Inventory only existing connectors relevant to the scenario. Capture each connector's business capability and read/write boundary.
3. Write the happy path in business order.
4. Add branches for missing information, user changes, cancellations, connector failures, empty results, and unsupported requests.
5. Add explicit confirmation and external write rules.
6. Add response boundaries: what may be claimed, what must be caveated, and what must not be said.
7. Verify frontmatter matches connector references in the body.
8. Scan the result for implementation terms and remove them.

## Connector References

Use connector references only when the procedure intentionally requires that existing business tool:

- Good: `通过 {@connectors.maintenance.getAvailableSlots} 查询门店可预约时段。`
- Good: `只有用户明确确认预约草稿后，才通过 {@connectors.maintenance.confirmBooking} 提交正式预约。`
- Bad: `通过 {@connectors.maintenance.findBestDealer} 自动选择最优门店。` when that connector does not exist.

If the connector namespace is not finalized or the connector is absent, do not invent the id. Ask for clarification or write the business need without a connector reference only when the user explicitly wants a draft despite the gap.

## Review Checklist

Before finishing a procedure, verify:

- The document starts with valid YAML frontmatter.
- Frontmatter `connectors` and `external_writes` match the connector references in the body.
- Every connector reference exists and has a business reason plus a trigger condition.
- Every external write has explicit user confirmation or a clear business trigger.
- The output follows the required template or has an explicit domain reason for a tighter structure.
- Missing-information, confirmation, failure, and risk-limit prompts are specific and professional enough for a business user.
- Missing information, changed information, empty connector results, connector failures, and unsupported requests are handled.
- Response boundaries are stated for regulated or high-risk domains.
- No implementation file names, internal execution concepts, code schemas, fake data, or test mechanics remain.
