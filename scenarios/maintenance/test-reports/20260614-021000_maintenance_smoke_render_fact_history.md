# Maintenance booking smoke test - render runtime fact history

- Scenario: `scenarios/maintenance/maintenance_booking.workflow.ts`
- Session: `codex_render_fact_history_v1`
- Command: `npm run chat:maintenance -- --no-stream --session-id codex_render_fact_history_v1 --message hi --message 1 --message 明天下午`
- Goal: verify Render does not imitate historical workflow tool-call transcripts after tool history is exposed as runtime facts.
- Score: 9/10

## Conversation

User:

```text
hi
```

Assistant:

```text
你好！欢迎使用保养预约助手。

你的车辆已确认：**2023 BMW X3 xDrive30i**（车牌：NJ-FX3023）

当前需要选择一家经销商。以下是为你推荐的4家保养服务商：

1. **Hoboken BMW Service**（Hoboken）—— 距你约1.8公里，品牌认证，Mon-Fri 08:00-18:00，Sat 09:00-15:00
2. **Manhattan BMW Service Center**（纽约曼哈顿）—— 距你约6.4公里，品牌认证，Mon-Sat 08:00-18:30
3. **Brooklyn MINI Service**（布鲁克林）—— 距你约8.9公里，品牌认证，Mon-Fri 08:00-18:00，Sun 10:00-14:00
4. **Jersey City European Auto Care**（泽西市）—— 距你约3.2公里，独立专业店，Mon-Fri 07:30-17:30

请问你希望选择哪一家作为保养服务商？也可以直接告诉我店名或编号。
```

User:

```text
1
```

Assistant:

```text
好的，你选择了 **Hoboken BMW Service**。

地址：100 Observer Hwy, Hoboken, NJ 07030
电话：+1-201-555-0300
营业时间：Mon-Fri 08:00-18:00，Sat 09:00-15:00

接下来，请告诉我你希望哪天到店保养？比如具体日期和时间。
```

User:

```text
明天下午
```

Assistant:

```text
好的，明天（6月14日）下午 Hoboken BMW Service 有以下可选时段：

1. **14:30 - 16:00**（服务顾问：Daniel Kim）
2. **16:00 - 17:30**（服务顾问：Daniel Kim）

请问你希望选择哪个时间到店？
```

## Result

- Dealer selection advanced through Patch and Render asked for the missing date/time.
- Date/time input triggered availability lookup and Render listed selectable slots.
- No DSML, XML, JSON, or connector tool-call text appeared in user-visible replies.
- No structured-output failure occurred.

## Remaining Risk

- This is a real LLM smoke run, so response wording can vary. The verified invariant is that runtime tool history is no longer presented to Render as provider-native tool-call messages.
