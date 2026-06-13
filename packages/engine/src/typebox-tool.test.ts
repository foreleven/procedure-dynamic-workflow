import "dotenv/config";
import assert from "node:assert/strict";
import {
  complete,
  getModel,
  Type,
  type Message,
  type Model,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

const toolName = "emit_structured_result";

const tool: Tool = {
  name: toolName,
  description: [
    "Emit the final structured result.",
    "This tool is mandatory and must be called exactly once.",
    "Return only schema-valid arguments.",
  ].join(" "),
  parameters: Type.Object({
    answer: Type.String({ description: "A short greeting." }),
  }),
};

const attempts = Number(process.env.TYPEBOX_TOOL_TEST_ATTEMPTS ?? "5");
const messages: Message[] = [{
  role: "user",
  content: "Return a short greeting as structured output.",
  timestamp: Date.now(),
}];

let successCount = 0;
const failures: string[] = [];

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const toolCall = await callTypeBoxTool(attempt);
    successCount += 1;
    console.log(`ok ${attempt}: ${JSON.stringify(toolCall.arguments)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`attempt ${attempt}: ${message}`);
    console.log(`not ok ${attempt}: ${message}`);
  }
}

console.log(`TypeBox tool calls: ${successCount}/${attempts}`);
assert.equal(failures.length, 0, failures.join("\n"));

async function callTypeBoxTool(attempt: number): Promise<ToolCall> {
  const model =getModel("deepseek", "deepseek-v4-flash")
  const message = await complete(
    model,
    {
      systemPrompt: [
        "You must call exactly one tool: emit_structured_result.",
        "The tool call is the final answer. Do not write text outside the tool call.",
      ].join("\n"),
      messages,
      tools: [tool],
    },
    {
      toolChoice: { type: "function", function: { name: toolName } },
      maxTokens: 256,
    },
  );

  console.log(`Message content: ${JSON.stringify(message)}`);

  const toolCall = message.content.find(
    (block): block is ToolCall => block.type === "toolCall" && block.name === toolName,
  );

  if (!toolCall) {
    throw new Error(
      [
        `missing ${toolName}`,
        `stopReason=${message.stopReason}`,
        `content=${JSON.stringify(message.content)}`,
        `responseModel=${message.responseModel ?? model.id}`,
        `attempt=${attempt}`,
      ].join(" "),
    );
  }

  return toolCall;
}

