# Maintenance booking smoke test - patch/render system prompt

- Scenario: `agents/maintenance/workflows/maintenance_booking.workflow.ts`
- Session: `codex_patch_render_system_prompt_state`
- Command: `npm run chat:maintenance -- --no-stream --session-id codex_patch_render_system_prompt_state --message hi --message 1 --message 明天下午 --message /state`
- Goal: verify a multi-turn user flow can select a dealer and then see time-slot choices after providing a preferred time window.
- Score: 8/10

## Conversation

User:

```text
hi
```

Assistant:

```text
你好！你的座驾是 **BMW X3 xDrive30i**，距离下次保养建议里程(30000 mi)已经很近了。请选择一家经销商进行预约：

1. **Hoboken BMW Service** — 100 Observer Hwy, Hoboken, NJ (1.8 km) 距你最近
2. **Manhattan BMW Service Center** — 555 W 57th St, New York, NY
3. **Brooklyn MINI Service** — 89 Atlantic Ave, Brooklyn, NY
4. **Jersey City European Auto Care** — 245 Marin Blvd, Jersey City, NJ

你想选哪一家？或者直接输入店名也行。
```

User:

```text
1
```

Assistant:

```text
好的，已选择 **Hoboken BMW Service**。请问你希望哪天到店保养？请提供日期和时间，比如 "这周五下午 2 点" 或 "3 月 20 日上午"。
```

User:

```text
明天下午
```

Assistant:

```text
明天下午（6月14日）Hoboken BMW 有以下两个可预约时段：

1. **14:30 - 16:00**（服务顾问：Daniel Kim）
2. **16:00 - 17:30**（服务顾问：Daniel Kim）

请问你选哪个时段？
```

## Result

- The CLI showed the date/time prompt after dealer selection.
- The next turn queried appointment availability and rendered two selectable time slots.
- No DSML, XML, JSON, or connector tool-call text leaked into the assistant response.
- No `emit_structured_result` error occurred during the tested flow.

## Remaining Risk

- Relative date resolution still depends on the runtime `now` value and scenario slot data. This report only verifies that the flow reaches time-slot selection.
