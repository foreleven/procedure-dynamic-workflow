import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createLlmClient } from "./llm.js";

test("createLlmClient validates public construction options", () => {
  assert.doesNotThrow(() => createLlmClient());
  assert.throws(
    () => createLlmClient(null as never),
    /LLM client options must be an object/,
  );
  assert.throws(
    () => createLlmClient({ apiKey: "   " }),
    /LLM client options\.apiKey must be a non-empty string/,
  );
  assert.throws(
    () => createLlmClient({ baseURL: "not-a-url" }),
    /LLM client options\.baseURL must be a valid absolute URL/,
  );
  assert.throws(
    () => createLlmClient({ logger: "console" as never }),
    /LLM client options\.logger must be a function/,
  );
  assert.throws(
    () =>
      createLlmClient({
        model: {
          id: "custom",
          name: "custom",
          api: "anthropic-messages",
          provider: "custom",
          baseUrl: "https://example.test/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        } as never,
      }),
    /LLM client options\.model\.api must be openai-completions/,
  );
});

test("LLM text requests fail validation before provider calls", async () => {
  const client = createLlmClient(testClientOptions());

  await assert.rejects(
    () => client.text(null as never),
    /LLM text request must be an object/,
  );
  await assert.rejects(
    () => client.text({ instruction: "   ", messages: [] }),
    /LLM text request\.instruction must be a non-empty string/,
  );
  await assert.rejects(
    () => client.text({ instruction: "Say hello.", model: " ", messages: [] }),
    /LLM text request\.model must be a non-empty string/,
  );
  await assert.rejects(
    () => client.text({ instruction: "Say hello.", messages: null } as never),
    /LLM text request\.messages must be an array/,
  );
  await assert.rejects(
    () =>
      client.text({
        instruction: "Say hello.",
        messages: [{ role: "user", content: [{ type: "text", text: 123 }], timestamp: Date.now() }] as never,
      }),
    /LLM text request\.messages\[0\]\.content\[0\]\.text must be a string/,
  );
});

test("LLM stream requests fail validation before provider calls", async () => {
  const client = createLlmClient(testClientOptions());

  await assert.rejects(
    () => drain(client.streamText?.({ instruction: "Say hello.", model: " ", messages: [] }) as never),
    /LLM streamText request\.model must be a non-empty string/,
  );
});

test("LLM structured requests validate name and schema before provider calls", async () => {
  const client = createLlmClient(testClientOptions());

  await assert.rejects(
    () =>
      client.structured({
        name: " ",
        instruction: "Extract a result.",
        schema: z.object({ ok: z.boolean() }),
        messages: [],
      }),
    /LLM structured request\.name must be a non-empty string/,
  );
  await assert.rejects(
    () =>
      client.structured({
        name: "result",
        instruction: "Extract a result.",
        schema: undefined as never,
        messages: [],
      }),
    /LLM structured request\.schema must be a Zod schema/,
  );
  await assert.rejects(
    () =>
      client.structured({
        name: "result",
        instruction: "Extract a result.",
        schema: { parse: () => ({ ok: true }) } as never,
        messages: [],
      }),
    /LLM structured request\.schema must be convertible to JSON Schema/,
  );
});

function testClientOptions() {
  return {
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    defaultModel: "test-model",
  };
}

/**
 * Drains an async iterable so validation inside async generator bodies is observed by tests.
 * Input: stream returned from `LlmClient.streamText`.
 * Output: resolves after all events are consumed.
 * Boundary: tests use it only for invalid streams, so no provider events should be produced.
 */
async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // Intentionally empty: the loop body only forces generator execution.
  }
}
