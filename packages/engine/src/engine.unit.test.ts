import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolMessage,
  createConnectorRegistry,
  definePatch,
  defineRouting,
  type WorkflowDefinition,
  workflow,
  z,
} from "@pac/workflow";
import { WorkflowEngine } from "./engine.js";
import type { LlmClient, LlmTextRequest } from "./llm/client.js";
import type { WorkflowDefinitionInput } from "./types.js";

interface TestState {
  selected: string | null;
  dependent: string | null;
  derived: string | null;
}

interface OptionalInvalidationState {
  selected: string | null;
  optionalDerived?: string | undefined;
}

interface SameTurnInvalidationState {
  source: string | null;
  dependent: string | null;
}

interface EffectDependencyState {
  selected: string | null;
  runs: number;
}

test("WorkflowEngine returns fallback response when the route gate does not match", async () => {
  const llm: LlmClient = {
    async text() {
      throw new Error("text generation should not run without a matched workflow");
    },
    async structured(request) {
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      throw new Error("patch extraction should not run without a matched workflow");
    },
  };
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_1", userId: "user_1" });

  const result = await engine.onMessage("unrelated request", session);

  assert.equal(result.response.text, "我还不能确定要执行哪个 workflow。");
  assert.deepEqual(result.responses, []);
  assert.deepEqual(session.activeWorkflowIds, []);
});

test("WorkflowEngine fails closed when the route gate output is malformed", async () => {
  const structuredCalls: unknown[] = [];
  const llm: LlmClient & { structuredCalls: unknown[] } = {
    structuredCalls,
    async text() {
      throw new Error("text generation should not run without a matched workflow");
    },
    async structured(request) {
      structuredCalls.push(request);
      if (request.name === "workflow_route") {
        throw new Error("malformed route output");
      }
      throw new Error("patch extraction should not run after a malformed route decision");
    },
  };
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_malformed_route", userId: "user_malformed_route" });

  const result = await engine.onMessage("please route me", session);

  assert.equal(result.response.text, "我还不能确定要执行哪个 workflow。");
  assert.deepEqual(result.responses, []);
  assert.deepEqual(session.activeWorkflowIds, []);
  assert.equal(routeCallCount(llm), 1);
  assert.equal(patchCallCount(llm), 0);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.none"));
});

test("WorkflowEngine fails closed when the route gate returns an unknown workflow id", async () => {
  const structuredCalls: unknown[] = [];
  const llm: LlmClient & { structuredCalls: unknown[] } = {
    structuredCalls,
    async text() {
      throw new Error("text generation should not run without a matched workflow");
    },
    async structured(request) {
      structuredCalls.push(request);
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecision("switch", ["missing_flow"], []));
      }
      throw new Error("patch extraction should not run after an invalid route decision");
    },
  };
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_unknown_route", userId: "user_unknown_route" });

  const result = await engine.onMessage("please route me", session);

  assert.equal(result.response.text, "我还不能确定要执行哪个 workflow。");
  assert.deepEqual(result.responses, []);
  assert.deepEqual(session.activeWorkflowIds, []);
  assert.equal(routeCallCount(llm), 1);
  assert.equal(patchCallCount(llm), 0);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.none"));
});

test("WorkflowEngine routes, patches, invalidates, runs nodes, and renders function output", async () => {
  const llm = createPatchLlm({
    sessionPatch: {
      facts: { source: "unit-test" },
      goals: ["exercise engine"],
    },
    statePatch: {
      selected: "picked",
    },
  });
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_2", userId: "user_2" });

  const result = await engine.onMessage("please route me", session);
  const instance = engine.getWorkflowSnapshot<TestState>(session, "test_flow");

  assert.equal(result.response.text, "selected=picked; dependent=default-dependent; derived=picked:loaded:true");
  assert.deepEqual(session.activeWorkflowIds, ["test_flow"]);
  assert.deepEqual(session.facts, { source: "unit-test" });
  assert.deepEqual(session.goals, ["exercise engine"]);
  assert.equal(instance?.state.selected, "picked");
  assert.equal(instance?.state.dependent, "default-dependent");
  assert.equal(instance?.state.derived, "picked:loaded:true");
  assert.deepEqual(instance?.prefetch, { baseline: "loaded" });
  assert.equal(instance?.state.messages.at(0)?.role, "user");
  assert.deepEqual(instance?.state.messages.at(-1), {
    role: "assistant",
    content: result.response.text,
  });
  assert.equal(patchCallCount(llm), 1);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.gate.new_session" && trace.workflowId === "engine"));
  assert.ok(result.traces.some((trace) => trace.phase === "invalidate"));
});

test("WorkflowEngine routes to every gate-matched workflow", async () => {
  const llm = createPatchLlm({ statePatch: { selected: "matched" } });
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow(), createCompetingWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_multi_route", userId: "user_multi_route" });

  const result = await engine.onMessage("please route me to competitor", session);

  assert.deepEqual(result.responses.map((response) => response.workflowId), ["test_flow", "competing_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow", "competing_flow"]);
  assert.equal(patchCallCount(llm), 2);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.gate.new_session" && trace.workflowId === "engine"));
});

test("WorkflowEngine suppresses weak gate matches when an accepted workflow exists", async () => {
  const llm = createPatchLlm({ statePatch: { selected: "matched" } });
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow(), createWeakRouteWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_route_thresholds", userId: "user_route_thresholds" });

  const result = await engine.onMessage("please route me", session);

  assert.deepEqual(result.responses.map((response) => response.workflowId), ["test_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow"]);
  assert.equal(patchCallCount(llm), 1);
  assert.ok(!result.responses.some((response) => response.workflowId === "weak_route_flow"));
});

test("WorkflowEngine exposes workflow snapshots without leaking mutable runtime instances", async () => {
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: { selected: "picked" } }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_snapshot", userId: "user_snapshot" });

  await engine.onMessage("please route me", session);
  const snapshot = engine.getWorkflowSnapshot<TestState>(session, "test_flow");
  assert.ok(snapshot);
  assert.equal("workflowInstances" in session, false);

  snapshot.state.selected = "mutated";
  snapshot.prefetch.baseline = "mutated";

  const nextSnapshot = engine.getWorkflowSnapshot<TestState>(session, "test_flow");
  assert.equal(nextSnapshot?.state.selected, "picked");
  assert.deepEqual(nextSnapshot?.prefetch, { baseline: "loaded" });
});

test("WorkflowEngine invalidation deletes fields that are absent from the default state", async () => {
  const engine = new WorkflowEngine({
    workflows: [createOptionalInvalidationWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: { selected: "picked" } }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_optional_invalidation",
    userId: "user_optional_invalidation",
    activeWorkflowIds: ["optional_invalidation_flow"],
  });

  const result = await engine.onMessage("run optional invalidation", session);
  const instance = engine.getWorkflowSnapshot<OptionalInvalidationState>(session, "optional_invalidation_flow");

  assert.equal(result.response.text, "hasOptional=false; value=missing");
  assert.equal("optionalDerived" in (instance?.state ?? {}), false);
  assert.ok(result.traces.some((trace) => trace.phase === "invalidate"));
});

test("WorkflowEngine preserves message-patched dependents from later same-turn derivation invalidation", async () => {
  const engine = new WorkflowEngine({
    workflows: [createSameTurnInvalidationWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: { dependent: "explicit-dependent" } }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_same_turn_invalidation",
    userId: "user_same_turn_invalidation",
    activeWorkflowIds: ["same_turn_invalidation_flow"],
  });

  const result = await engine.onMessage("set dependent and derive source", session);
  const instance = engine.getWorkflowSnapshot<SameTurnInvalidationState>(session, "same_turn_invalidation_flow");

  assert.equal(result.response.text, "source=derived-source; dependent=explicit-dependent");
  assert.equal(instance?.state.source, "derived-source");
  assert.equal(instance?.state.dependent, "explicit-dependent");
  assert.ok(!result.traces.some((trace) => trace.phase === "invalidate"));
});

test("WorkflowEngine ignores state patch writes to reserved runtime messages", async () => {
  const engine = new WorkflowEngine({
    workflows: [createReservedMessagesPatchWorkflow()],
    deps: {
      llm: createPatchLlm({
        statePatch: {
          selected: "picked",
          messages: [{ role: "assistant", content: "replace history" }],
        },
      }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({ sessionId: "session_reserved_messages", userId: "user_reserved_messages" });

  const result = await engine.onMessage("please route me", session);
  const instance = engine.getWorkflowSnapshot<TestState>(session, "reserved_messages_patch_flow");

  assert.equal(result.response.text, "selected=picked; messages=2");
  assert.deepEqual(instance?.state.messages, [
    { role: "user", content: "please route me" },
    { role: "tool", name: "load_baseline", call: { stage: "beforePatch" }, result: { baseline: "loaded" } },
    { role: "assistant", content: "selected=picked; messages=2" },
  ]);
});

test("WorkflowEngine validates function render responses", async () => {
  const engine = new WorkflowEngine({
    workflows: [
      {
        ...createTestWorkflow(),
        id: "bad_function_render_flow",
        render: () => ({ data: "missing text" }) as never,
      },
    ],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_bad_function_render",
    userId: "user_bad_function_render",
    activeWorkflowIds: ["bad_function_render_flow"],
  });

  await assert.rejects(
    engine.onMessage("bad function render", session),
    /Workflow bad_function_render_flow render\.text must be a string/,
  );
});

test("WorkflowEngine validates raw prefetch node results", async () => {
  const workflow = createTestWorkflow();
  const engineWithArrayPrefetch = new WorkflowEngine({
    workflows: [
      {
        ...workflow,
        nodes: workflow.nodes.map((node) =>
          node.name === "load_baseline"
            ? {
                ...node,
                run: () => [] as never,
              }
            : node,
        ),
      },
    ],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });

  await assert.rejects(
    engineWithArrayPrefetch.onMessage(
      "bad prefetch",
      engineWithArrayPrefetch.createSession({
        sessionId: "session_bad_prefetch_array",
        userId: "user_bad_prefetch_array",
        activeWorkflowIds: ["test_flow"],
      }),
    ),
    /Workflow test_flow prefetch result must be a plain object/,
  );

  const engineWithBlankPrefetchKey = new WorkflowEngine({
    workflows: [
      {
        ...workflow,
        nodes: workflow.nodes.map((node) =>
          node.name === "load_baseline"
            ? {
                ...node,
                run: () => ({ "": "bad" }),
              }
            : node,
        ),
      },
    ],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });

  await assert.rejects(
    engineWithBlankPrefetchKey.onMessage(
      "bad prefetch",
      engineWithBlankPrefetchKey.createSession({
        sessionId: "session_bad_prefetch_key",
        userId: "user_bad_prefetch_key",
        activeWorkflowIds: ["test_flow"],
      }),
    ),
    /Workflow test_flow prefetch key must be a non-empty string/,
  );
});

test("WorkflowEngine streams render policy deltas and stores final assistant response", async () => {
  const deltas: string[] = [];
  const llm = createStreamingLlm({
    patch: { statePatch: { selected: "streamed" } },
    deltas: ["hello", " ", "world"],
    finalText: "hello world",
  });
  const engine = new WorkflowEngine({
    workflows: [createStreamingWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
    onResponseDelta: ({ workflowId, delta }) => {
      deltas.push(`${workflowId}:${delta}`);
    },
  });
  const session = engine.createSession({ sessionId: "session_3", userId: "user_3" });

  const result = await engine.onMessage("please stream", session);
  const instance = engine.getWorkflowSnapshot<TestState>(session, "stream_flow");

  assert.equal(result.response.text, "hello world");
  assert.deepEqual(deltas, ["stream_flow:hello", "stream_flow: ", "stream_flow:world"]);
  assert.deepEqual(instance?.state.messages.at(-1), {
    role: "assistant",
    content: "hello world",
  });
  assert.equal(llm.streamCalls.length, 1);
  assert.equal(llm.textCalls.length, 0);
});

test("WorkflowEngine passes derived ToolMessage history to render as runtime fact text", async () => {
  const llm = createStreamingLlm({
    patch: { statePatch: {} },
    deltas: [],
    finalText: "rendered from tool history",
  });
  const engine = new WorkflowEngine({
    workflows: [createToolRenderWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_tool_render",
    userId: "user_tool_render",
    activeWorkflowIds: ["tool_render_flow"],
  });

  const result = await engine.onMessage("show available slot", session);

  assert.equal(result.response.text, "rendered from tool history");
  assert.equal(llm.streamCalls.length, 1);
  const renderRequest = llm.streamCalls[0] as LlmTextRequest | undefined;
  assert.ok(renderRequest);
  assert.deepEqual(renderRequest.messages.map((message) => message.role), ["user", "assistant"]);

  const factMessage = renderRequest.messages[1];
  if (factMessage?.role !== "assistant") {
    throw new Error("Expected assistant runtime fact message before render");
  }
  const [content] = factMessage.content;
  assert.equal(content?.type, "text");
  if (content?.type !== "text") {
    throw new Error("Expected text runtime fact content before render");
  }
  assert.match(content.text, /Runtime tool fact: connectors\.lookup/);
  assert.match(content.text, /"query": "slot"/);
  assert.match(content.text, /"slot": "09:00"/);
});

test("WorkflowEngine runs dependency-gated effects once per dependency snapshot and traces steps", async () => {
  const llm = createSequentialPatchLlm([
    { statePatch: { selected: "alpha" } },
    { statePatch: {} },
    { statePatch: { selected: "alpha" } },
    { statePatch: { selected: "beta" } },
  ]);
  const engine = new WorkflowEngine({
    workflows: [createEffectDependencyWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_effect_dependencies",
    userId: "user_effect_dependencies",
    activeWorkflowIds: ["effect_dependency_flow"],
  });

  const first = await engine.onMessage("select alpha", session);
  const second = await engine.onMessage("repeat without change", session);
  const third = await engine.onMessage("select alpha again", session);
  const fourth = await engine.onMessage("select beta", session);
  const instance = engine.getWorkflowSnapshot<EffectDependencyState>(session, "effect_dependency_flow");

  assert.equal(instance?.state.selected, "beta");
  assert.equal(instance?.state.runs, 2);
  assert.equal(first.response.text, "selected=alpha; runs=1");
  assert.equal(second.response.text, "selected=alpha; runs=1");
  assert.equal(third.response.text, "selected=alpha; runs=1");
  assert.equal(fourth.response.text, "selected=beta; runs=2");
  assert.equal(first.traces.filter((trace) => trace.phase === "node.step.start").length, 2);
  assert.equal(first.traces.filter((trace) => trace.phase === "node.step.end").length, 2);
  assert.ok(second.traces.some((trace) =>
    trace.phase === "node.afterPatch.load_selected.skip" &&
    isTraceReason(trace.detail, "dependencies"),
  ));
  assert.equal(second.traces.filter((trace) => trace.phase === "node.step.start").length, 0);
});

test("WorkflowEngine validates LLM render text output", async () => {
  const llm: LlmClient = {
    async structured(request) {
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      return request.schema.parse({ statePatch: {} });
    },
    async text() {
      return 123 as never;
    },
  };
  const engine = new WorkflowEngine({
    workflows: [createStreamingWorkflow({ id: "bad_llm_text_flow" })],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_bad_llm_text",
    userId: "user_bad_llm_text",
    activeWorkflowIds: ["bad_llm_text_flow"],
  });

  await assert.rejects(
    engine.onMessage("bad llm text", session),
    /Workflow bad_llm_text_flow llm\.text must be a string/,
  );
});

test("WorkflowEngine validates LLM stream events", async () => {
  const llm: LlmClient = {
    async structured(request) {
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      return request.schema.parse({ statePatch: {} });
    },
    async text() {
      throw new Error("text should not run when streamText is available");
    },
    async *streamText() {
      yield { type: "text_delta", delta: 123 as never };
    },
  };
  const engine = new WorkflowEngine({
    workflows: [createStreamingWorkflow({ id: "bad_stream_event_flow" })],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
    onResponseDelta: () => undefined,
  });
  const session = engine.createSession({
    sessionId: "session_bad_stream_event",
    userId: "user_bad_stream_event",
    activeWorkflowIds: ["bad_stream_event_flow"],
  });

  await assert.rejects(
    engine.onMessage("bad stream event", session),
    /Workflow bad_stream_event_flow streamText text_delta\.delta must be a string/,
  );
});

test("WorkflowEngine serializes stream deltas across active workflows", async () => {
  const deltas: string[] = [];
  const llm = createNamedStreamingLlm({
    patch: { statePatch: { selected: "multi" } },
    streams: {
      stream_a_render: {
        deltas: ["a1", "a2"],
        finalText: "a1a2",
        delayMs: 2,
      },
      stream_b_render: {
        deltas: ["b1", "b2"],
        finalText: "b1b2",
      },
    },
  });
  const engine = new WorkflowEngine({
    workflows: [
      createStreamingWorkflow({ id: "stream_a", renderName: "stream_a_render", route: "alpha" }),
      createStreamingWorkflow({ id: "stream_b", renderName: "stream_b_render", route: "beta" }),
    ],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
    onResponseDelta: ({ workflowId, delta }) => {
      deltas.push(`${workflowId}:${delta}`);
    },
  });
  const session = engine.createSession({
    sessionId: "session_streams",
    userId: "user_streams",
    activeWorkflowIds: ["stream_a", "stream_b"],
  });

  const result = await engine.onMessage("message for active workflows", session);

  assert.deepEqual(result.responses.map((response) => response.workflowId), ["stream_a", "stream_b"]);
  assert.equal(result.response.text, "a1a2");
  assert.deepEqual(deltas, ["stream_a:a1", "stream_a:a2", "stream_b:b1", "stream_b:b2"]);
  assert.deepEqual(llm.streamCalls, ["stream_a_render", "stream_b_render"]);
});

test("WorkflowEngine runs afterPatch stages for active workflows concurrently", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const engine = new WorkflowEngine({
    workflows: [
      createConcurrentAfterPatchWorkflow("concurrent_a", "alpha", () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return () => {
          inFlight -= 1;
        };
      }),
      createConcurrentAfterPatchWorkflow("concurrent_b", "beta", () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return () => {
          inFlight -= 1;
        };
      }),
    ],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_concurrent_after_patch",
    userId: "user_concurrent_after_patch",
    activeWorkflowIds: ["concurrent_a", "concurrent_b"],
  });

  await engine.onMessage("run both", session);

  assert.equal(maxInFlight, 2);
});

test("WorkflowEngine stops unstable afterPatch nodes at maxProgramRounds", async () => {
  const engine = new WorkflowEngine({
    workflows: [createMaxRoundsWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
    maxProgramRounds: 2,
  });
  const session = engine.createSession({
    sessionId: "session_4",
    userId: "user_4",
    activeWorkflowIds: ["round_flow"],
  });

  const result = await engine.onMessage("any active message", session);
  const instance = engine.getWorkflowSnapshot<{ count: number }>(session, "round_flow");

  assert.equal(result.response.text, "count=2");
  assert.equal(instance?.state.count, 2);
  assert.ok(result.traces.some((trace) => trace.phase === "nodes.afterPatch.maxRounds"));
});

test("WorkflowEngine can switch away from active workflows through the route gate", async () => {
  const llm = createPatchLlm({ statePatch: { selected: "active" } });
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow(), createCompetingWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_5",
    userId: "user_5",
    activeWorkflowIds: ["test_flow"],
  });

  const result = await engine.onMessage("please competitor", session);
  const activeInstance = engine.getWorkflowSnapshot<TestState>(session, "test_flow");
  const competingInstance = engine.getWorkflowSnapshot<TestState>(session, "competing_flow");

  assert.deepEqual(result.responses.map((response) => response.workflowId), ["competing_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["competing_flow"]);
  assert.deepEqual(session.routingMemory.suspendedWorkflowIds, ["test_flow"]);
  assert.equal(activeInstance?.state.selected, null);
  assert.equal(competingInstance?.state.selected, "active");
  assert.ok(result.traces.some((trace) => trace.phase === "routing.switch"));
  assert.equal(patchCallCount(llm), 2);
});

test("WorkflowEngine can append a parallel workflow through the route gate", async () => {
  const llm = createPatchLlm({ statePatch: { selected: "active" } });
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow(), createCompetingWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_parallel_route",
    userId: "user_parallel_route",
    activeWorkflowIds: ["test_flow"],
  });

  const result = await engine.onMessage("also competitor", session);

  assert.deepEqual(result.responses.map((response) => response.workflowId), ["test_flow", "competing_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow", "competing_flow"]);
  assert.equal(session.routingMemory.suspendedWorkflowIds, undefined);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.parallel"));
});

test("WorkflowEngine skips the route gate when a short reply resolves active ack", async () => {
  const llm = createPatchLlm({ statePatch: {} });
  const engine = new WorkflowEngine({
    workflows: [createAckWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_ack_fast_path",
    userId: "user_ack_fast_path",
    activeWorkflowIds: ["ack_flow"],
  });

  await engine.onMessage("start ack", session);
  const routeCallsAfterFirstTurn = routeCallCount(llm);
  const result = await engine.onMessage("确认", session);

  assert.equal(routeCallCount(llm), routeCallsAfterFirstTurn);
  assert.deepEqual(result.responses.map((response) => response.workflowId), ["ack_flow"]);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.protocol_fast_path"));
  assert.ok(result.traces.some((trace) => trace.phase === "routing.continue"));
});

test("WorkflowEngine rejects invalid active workflow ids during session creation", () => {
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });

  assert.throws(
    () =>
      engine.createSession({
        sessionId: "session_unknown",
        userId: "user_1",
        activeWorkflowIds: ["missing_flow"],
      }),
    /Unknown active workflow id\(s\): missing_flow/,
  );
  assert.throws(
    () =>
      engine.createSession({
        sessionId: "session_duplicate",
        userId: "user_1",
        activeWorkflowIds: ["test_flow", "test_flow"],
      }),
    /Duplicate active workflow id: test_flow/,
  );
});

test("WorkflowEngine validates onMessage input and active workflow ids", async () => {
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_on_message",
    userId: "user_1",
    activeWorkflowIds: ["test_flow"],
  });

  await assert.rejects(
    engine.onMessage("", session),
    /Invalid message: message must be a non-empty string/,
  );
  session.activeWorkflowIds.push("missing_flow");
  await assert.rejects(
    engine.onMessage("route me", session),
    /unknown active workflow id\(s\): missing_flow/,
  );

  session.activeWorkflowIds.pop();
  session.activeWorkflowIds.push("test_flow");
  await assert.rejects(
    engine.onMessage("route me", session),
    /duplicate active workflow id: test_flow/,
  );
});

test("WorkflowEngine rejects runtime workflow state invariants during construction", () => {
  const workflow = createTestWorkflow();

  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        state: { ...workflow.state, messages: [] },
      }),
    /Workflow test_flow default state must not define reserved messages field/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        stateSchema: z
          .object({
            selected: z.string().nullable(),
            dependent: z.string().nullable(),
            derived: z.string().nullable(),
          })
          .transform((state) => ({ ...state, messages: [] })),
      }),
    /Workflow test_flow parsed default state must not define reserved messages field/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        state: { ...workflow.state, selected: 123 },
      }),
    /Workflow test_flow default state does not satisfy stateSchema/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        state: { ...workflow.state, helper: () => undefined },
      }),
    /Workflow test_flow default state is not cloneable/,
  );
});

test("WorkflowEngine rejects invalid engine option invariants during construction", () => {
  const workflow = createTestWorkflow();

  assert.throws(
    () =>
      new WorkflowEngine({
        workflows: [workflow],
        deps: {
          connectors: createConnectorRegistry(),
          llm: createPatchLlm({ statePatch: {} }),
        },
        maxProgramRounds: 0,
      }),
    /maxProgramRounds must be a positive integer/,
  );
});

test("WorkflowEngine rejects duplicate workflow ids during construction", () => {
  const workflow = createTestWorkflow();

  assert.throws(
    () =>
      new WorkflowEngine({
        workflows: [workflow, { ...workflow, description: "Duplicate id fixture." }],
        deps: {
          llm: createPatchLlm({ statePatch: {} }),
          connectors: createConnectorRegistry(),
        },
      }),
    /Duplicate workflow id: test_flow/,
  );
});

test("WorkflowEngine logger handles non-serializable node details", async () => {
  const logs: string[] = [];
  const engine = new WorkflowEngine({
    workflows: [createDiagnosticWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
    logger: (line) => logs.push(line),
  });
  const session = engine.createSession({
    sessionId: "session_diagnostic",
    userId: "user_diagnostic",
    activeWorkflowIds: ["diagnostic_flow"],
  });

  const result = await engine.onMessage("diagnose", session);

  assert.equal(result.response.text, "diagnostic ok");
  assert.ok(logs.some((line) => line.includes("[Circular]")));
});

function createTestWorkflow(): WorkflowDefinition<TestState> {
  return {
    id: "test_flow",
    version: "0.1.0",
    description: "Test flow for engine route coverage.",
    routing: defineRouting({
      examples: ["route me"],
      entities: ["route"],
      neighbors: [],
    }),
    stateSchema: z.object({
      selected: z.string().nullable(),
      dependent: z.string().nullable(),
      derived: z.string().nullable(),
    }),
    state: {
      selected: null,
      dependent: "default-dependent",
      derived: null,
    },
    patch: definePatch({
      progress: "Extracting patch",
      state: {
        selected: z.string().nullable(),
      },
    }),
    invalidation: {
      selected: ["dependent"],
    },
    nodes: [
      {
        kind: "effect",
        name: "prepare_dependent",
        stage: "beforePatch",
        progress: "Preparing dependent field",
        description: "Seeds dependent state so patch invalidation has an observable reset.",
        run: () => ({ state: { dependent: "runtime-dependent" } }),
      },
      {
        kind: "prefetch",
        name: "load_baseline",
        stage: "beforePatch",
        progress: "Loading baseline data",
        description: "Loads deterministic baseline data for afterPatch derivation.",
        run: () => ({ baseline: "loaded" }),
      },
      {
        kind: "effect",
        name: "derive_state",
        stage: "afterPatch",
        progress: "Deriving state",
        description: "Derives stable state from the selected value and prefetch cache.",
        when: ({ state }) => state.selected !== null,
        run: ({ state, prefetch, turn }) => ({
          state: {
            derived: `${state.selected}:${prefetch.get("baseline")}:${turn.invalidatedStateFields.includes("dependent")}`,
          },
        }),
      },
    ],
    render: ({ state }) => ({
      text: `selected=${state.selected}; dependent=${state.dependent}; derived=${state.derived}`,
    }),
  };
}

function createReservedMessagesPatchWorkflow(): WorkflowDefinition<TestState> {
  return {
    ...createTestWorkflow(),
    id: "reserved_messages_patch_flow",
    patch: {
      instruction: "Bypass definePatch so engine-level reserved field filtering is observable.",
      schema: z.object({
        statePatch: z
          .object({
            selected: z.string().nullable().optional(),
            messages: z
              .array(z.object({
                role: z.string(),
                content: z.string(),
              }))
              .optional(),
          })
          .optional(),
      }),
    },
    render: ({ state }) => ({
      text: `selected=${state.selected}; messages=${state.messages.length}`,
    }),
  };
}

function createOptionalInvalidationWorkflow(): WorkflowDefinition<OptionalInvalidationState> {
  return {
    id: "optional_invalidation_flow",
    version: "0.1.0",
    description: "Optional invalidation workflow test fixture.",
    routing: defineRouting({
      examples: ["optional invalidation"],
      entities: ["optional"],
      neighbors: [],
    }),
    stateSchema: z.object({
      selected: z.string().nullable(),
      optionalDerived: z.string().optional(),
    }),
    state: {
      selected: null,
    },
    patch: definePatch({
      state: {
        selected: z.string().nullable(),
      },
    }),
    invalidation: {
      selected: ["optionalDerived"],
    },
    nodes: [
      {
        kind: "effect",
        name: "seed_optional",
        stage: "beforePatch",
        progress: "Seeding optional state",
        description: "Seeds an optional state field before invalidation resets it to absent default.",
        run: () => ({ state: { optionalDerived: "runtime-value" } }),
      },
    ],
    render: ({ state }) => ({
      text: `hasOptional=${Object.hasOwn(state, "optionalDerived")}; value=${state.optionalDerived ?? "missing"}`,
    }),
  };
}

function createSameTurnInvalidationWorkflow(): WorkflowDefinition<SameTurnInvalidationState> {
  return {
    id: "same_turn_invalidation_flow",
    version: "0.1.0",
    description: "Same-turn invalidation workflow test fixture.",
    routing: defineRouting({
      examples: ["same turn invalidation"],
      entities: ["same-turn"],
      neighbors: [],
    }),
    stateSchema: z.object({
      source: z.string().nullable(),
      dependent: z.string().nullable(),
    }),
    state: {
      source: null,
      dependent: null,
    },
    patch: definePatch({
      state: {
        dependent: z.string().nullable(),
      },
    }),
    invalidation: {
      source: ["dependent"],
    },
    nodes: [
      {
        kind: "effect",
        name: "seed_dependent",
        stage: "beforePatch",
        progress: "Seeding dependent state",
        description: "Writes the same dependent value that the message patch confirms later in the turn.",
        run: () => ({ state: { dependent: "explicit-dependent" } }),
      },
      {
        kind: "effect",
        name: "derive_source",
        stage: "afterPatch",
        progress: "Deriving source state",
        description: "Writes the invalidation source after message patch writes the dependent field.",
        when: ({ state }) => state.source === null,
        run: () => ({ state: { source: "derived-source" } }),
      },
    ],
    render: ({ state }) => ({
      text: `source=${state.source}; dependent=${state.dependent}`,
    }),
  };
}

function createDiagnosticWorkflow(): WorkflowDefinition<{ value?: unknown }> {
  const circular: { self?: unknown } = {};
  circular.self = circular;

  return {
    id: "diagnostic_flow",
    version: "0.1.0",
    description: "Diagnostic logging workflow test fixture.",
    routing: defineRouting({
      examples: ["diagnose"],
      entities: ["diagnose"],
      neighbors: [],
    }),
    stateSchema: z.object({
      value: z.unknown().optional(),
    }),
    state: {},
    patch: definePatch({
      state: {},
    }),
    invalidation: {},
    nodes: [
      {
        kind: "effect",
        name: "write_circular_state",
        stage: "afterPatch",
        progress: "Writing diagnostic state",
        description: "Writes a circular runtime value so logger serialization is observable.",
        when: ({ state }) => state.value === undefined,
        run: () => ({ state: { value: circular } }),
      },
    ],
    render: () => ({
      text: "diagnostic ok",
    }),
  };
}

function createEngineWithWorkflow(workflow: unknown): WorkflowEngine {
  return new WorkflowEngine({
    workflows: [workflow as WorkflowDefinitionInput],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
}

function createCompetingWorkflow(): WorkflowDefinition<TestState> {
  return {
    ...createTestWorkflow(),
    id: "competing_flow",
    description: "Competing workflow route fixture.",
    routing: defineRouting({
      examples: ["competitor"],
      entities: ["competitor"],
      neighbors: [],
    }),
    render: ({ state }) => ({
      text: `competing=${state.selected}`,
    }),
  };
}

function createAckWorkflow(): WorkflowDefinition<{ acknowledged: boolean }> {
  return {
    id: "ack_flow",
    version: "0.1.0",
    description: "Ack workflow test fixture.",
    routing: defineRouting({
      examples: ["ack"],
      entities: ["ack"],
      neighbors: [],
    }),
    stateSchema: z.object({
      acknowledged: z.boolean(),
    }),
    state: {
      acknowledged: false,
    },
    patch: definePatch({
      state: {},
    }),
    invalidation: {},
    nodes: [
      {
        kind: "effect",
        name: "request_ack",
        stage: "afterPatch",
        description: "Stores an ack request so the next short reply can use protocol fast path.",
        run: ({ context }) => {
          context.ack({
            id: "confirm_ack",
            prompt: "确认继续吗？",
            options: [{ id: "yes", label: "确认" }],
          });
          return {};
        },
      },
    ],
    render: () => ({
      text: "ack pending",
    }),
  };
}

function createWeakRouteWorkflow(): WorkflowDefinition<TestState> {
  return {
    ...createTestWorkflow(),
    id: "weak_route_flow",
    description: "Weak lexical fixture.",
    routing: defineRouting({
      examples: ["weak only"],
      entities: ["route"],
      neighbors: [],
    }),
    render: ({ state }) => ({
      text: `weak=${state.selected}`,
    }),
  };
}

function createStreamingWorkflow(config: {
  id?: string;
  renderName?: string;
  route?: string;
} = {}): WorkflowDefinition<TestState> {
  const id = config.id ?? "stream_flow";
  const route = config.route ?? "stream";

  return {
    ...createTestWorkflow(),
    id,
    description: "Streaming render workflow test fixture.",
    routing: defineRouting({
      examples: [route],
      entities: [route],
      neighbors: [],
    }),
    render: {
      name: config.renderName ?? `${id}_render`,
      instruction: "Stream the final response.",
      progress: "Streaming response",
    },
  };
}

function createConcurrentAfterPatchWorkflow(
  id: string,
  route: string,
  enter: () => () => void,
): WorkflowDefinition<{ done: boolean }> {
  return {
    id,
    version: "0.1.0",
    description: `${id} concurrent afterPatch fixture.`,
    routing: defineRouting({
      examples: [route],
      entities: [route],
      neighbors: [],
    }),
    stateSchema: z.object({
      done: z.boolean(),
    }),
    state: {
      done: false,
    },
    patch: definePatch({
      state: {},
    }),
    invalidation: {},
    nodes: [
      {
        kind: "effect",
        name: "concurrent_effect",
        stage: "afterPatch",
        description: "Waits briefly so the test can observe cross-workflow concurrency.",
        when: ({ state }) => state.done === false,
        run: async () => {
          const leave = enter();
          await new Promise((resolve) => setTimeout(resolve, 10));
          leave();
          return { state: { done: true } };
        },
      },
    ],
    render: ({ state }) => ({
      text: `${id}:${state.done}`,
    }),
  };
}

function createToolRenderWorkflow(): WorkflowDefinition<{ done: boolean }> {
  const program = workflow({
    id: "tool_render_flow",
    version: "0.1.0",
    description: "Tool render workflow test fixture.",
    routing: defineRouting({
      examples: ["tool render"],
      entities: ["tool"],
      neighbors: [],
    }),
    stateSchema: z.object({
      done: z.boolean(),
    }),
    state: {
      done: false,
    },
  });

  program.patch({ state: {} });
  program.effect("lookup_tool", {
    description: "Appends connector-like facts as a ToolMessage so render sees provider-native tool history.",
    dependsOn: ["done"],
    run: (state) => {
      if (state.done) return {};
      return {
        done: true,
        messages: [
          new ToolMessage({
            name: "connectors.lookup",
            call: { query: "slot" },
            result: { slot: "09:00" },
          }),
        ],
      };
    },
  });

  return program.render({
    name: "tool_render",
    instruction: "Reply from tool history.",
    progress: "Rendering from tools",
  });
}

function createEffectDependencyWorkflow(): WorkflowDefinition<EffectDependencyState> {
  return {
    id: "effect_dependency_flow",
    version: "0.1.0",
    description: "Effect dependency workflow test fixture.",
    routing: defineRouting({
      examples: ["effect dependencies"],
      entities: ["effect"],
      neighbors: [],
    }),
    stateSchema: z.object({
      selected: z.string().nullable(),
      runs: z.number(),
    }),
    state: {
      selected: null,
      runs: 0,
    },
    patch: definePatch({
      state: {
        selected: z.string().nullable(),
      },
    }),
    invalidation: {},
    nodes: [
      {
        kind: "effect",
        name: "load_selected",
        stage: "afterPatch",
        progress: "Loading selected data",
        description: "Runs only when the selected state dependency changes and emits parallel loading steps.",
        dependsOn: ["selected"],
        when: ({ state }) => state.selected !== null,
        run: async ({ state, step }) => {
          const primary = step.start("Load primary connector");
          const secondary = step.start("Load secondary connector");

          await Promise.all([
            delay(1).then(() => primary.end({ connector: "primary" })),
            delay(1).then(() => secondary.end({ connector: "secondary" })),
          ]);

          return {
            state: {
              runs: state.runs + 1,
            },
          };
        },
      },
    ],
    render: ({ state }) => ({
      text: `selected=${state.selected}; runs=${state.runs}`,
    }),
  };
}

function createMaxRoundsWorkflow(): WorkflowDefinition<{ count: number }> {
  return {
    id: "round_flow",
    version: "0.1.0",
    description: "Max rounds workflow test fixture.",
    routing: defineRouting({
      examples: ["round"],
      entities: ["round"],
      neighbors: [],
    }),
    stateSchema: z.object({
      count: z.number(),
    }),
    state: {
      count: 0,
    },
    patch: definePatch({
      state: {
        count: z.number(),
      },
    }),
    invalidation: {},
    nodes: [
      {
        kind: "effect",
        name: "increment_forever",
        stage: "afterPatch",
        progress: "Incrementing count",
        description: "Always changes state so maxProgramRounds behavior is observable.",
        run: ({ state }) => ({ state: { count: state.count + 1 } }),
      },
    ],
    render: ({ state }) => ({
      text: `count=${state.count}`,
    }),
  };
}

function createPatchLlm(patch: unknown): LlmClient & { structuredCalls: unknown[] } {
  const structuredCalls: unknown[] = [];
  return {
    structuredCalls,
    async text() {
      throw new Error("text generation should not run for function render policies");
    },
    async structured(request) {
      structuredCalls.push(request);
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      return request.schema.parse(patch);
    },
  };
}

function createSequentialPatchLlm(patches: unknown[]): LlmClient & { structuredCalls: unknown[] } {
  const structuredCalls: unknown[] = [];
  let patchIndex = 0;
  return {
    structuredCalls,
    async text() {
      throw new Error("text generation should not run for function render policies");
    },
    async structured(request) {
      structuredCalls.push(request);
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      const patch = patches[patchIndex] ?? {};
      patchIndex += 1;
      return request.schema.parse(patch);
    },
  };
}

function createStreamingLlm(config: {
  patch: unknown;
  deltas: string[];
  finalText: string;
}): LlmClient & { structuredCalls: unknown[]; streamCalls: unknown[]; textCalls: unknown[] } {
  const structuredCalls: unknown[] = [];
  const streamCalls: unknown[] = [];
  const textCalls: unknown[] = [];

  return {
    structuredCalls,
    streamCalls,
    textCalls,
    async text(request) {
      textCalls.push(request);
      return config.finalText;
    },
    async structured(request) {
      structuredCalls.push(request);
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      return request.schema.parse(config.patch);
    },
    async *streamText(request) {
      streamCalls.push(request);
      for (const delta of config.deltas) {
        yield { type: "text_delta", delta };
      }
      yield { type: "done", text: config.finalText };
    },
  };
}

function createNamedStreamingLlm(config: {
  patch: unknown;
  streams: Record<string, { deltas: string[]; finalText: string; delayMs?: number }>;
}): LlmClient & { structuredCalls: unknown[]; streamCalls: string[]; textCalls: unknown[] } {
  const structuredCalls: unknown[] = [];
  const streamCalls: string[] = [];
  const textCalls: unknown[] = [];

  return {
    structuredCalls,
    streamCalls,
    textCalls,
    async text(request) {
      textCalls.push(request);
      const stream = config.streams[request.name ?? ""];
      if (!stream) throw new Error(`Missing stream config for ${request.name ?? "unnamed"}`);
      return stream.finalText;
    },
    async structured(request) {
      structuredCalls.push(request);
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      return request.schema.parse(config.patch);
    },
    async *streamText(request) {
      const name = request.name ?? "unnamed";
      const stream = config.streams[name];
      if (!stream) throw new Error(`Missing stream config for ${name}`);

      streamCalls.push(name);
      for (const delta of stream.deltas) {
        if (stream.delayMs) {
          await delay(stream.delayMs);
        }
        yield { type: "text_delta", delta };
      }
      yield { type: "done", text: stream.finalText };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function patchCallCount(llm: { structuredCalls: unknown[] }): number {
  return llm.structuredCalls.filter((call) => {
    return !call || typeof call !== "object" || (call as { name?: unknown }).name !== "workflow_route";
  }).length;
}

function routeCallCount(llm: { structuredCalls: unknown[] }): number {
  return llm.structuredCalls.filter((call) => {
    return call && typeof call === "object" && (call as { name?: unknown }).name === "workflow_route";
  }).length;
}

function routeDecisionForRequest(request: {
  messages: Array<{ content?: unknown }>;
}): unknown {
  const payload = parseRoutePayload(request.messages[0]?.content);
  const latestUserMessage = typeof payload.latestUserMessage === "string" ? payload.latestUserMessage : "";
  const activeWorkflows = Array.isArray(payload.activeWorkflows) ? payload.activeWorkflows : [];
  const candidateWorkflows = Array.isArray(payload.candidateWorkflows) ? payload.candidateWorkflows : [];
  const activeIds = activeWorkflows.flatMap(profileId);
  const matches = matchingRouteProfiles(latestUserMessage, candidateWorkflows);
  const matchedIds = matches.flatMap(profileId);

  if (activeIds.length > 0 && matchedIds.length === 0) {
    return routeDecision("continue", activeIds, []);
  }

  if (activeIds.length > 0 && matchedIds.every((id) => activeIds.includes(id))) {
    return routeDecision("continue", activeIds, []);
  }

  if (matchedIds.length > 0) {
    if (activeIds.length > 0 && /\balso\b|顺便|同时/.test(latestUserMessage)) {
      return routeDecision("parallel", matchedIds, []);
    }
    return routeDecision("switch", matchedIds, activeIds.filter((id) => !matchedIds.includes(id)));
  }

  return routeDecision("none", [], []);
}

function parseRoutePayload(content: unknown): Record<string, unknown> {
  if (typeof content !== "string") return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function matchingRouteProfiles(message: string, profiles: unknown[]): unknown[] {
  const normalized = message.toLowerCase();
  const exampleMatches = profiles.filter((profile) => profileTerms(profile, "examples").some((term) => includesTerm(normalized, term)));
  if (exampleMatches.length > 0) return exampleMatches;

  const entityMatches = profiles.filter((profile) => profileTerms(profile, "entities").some((term) => includesTerm(normalized, term)));
  if (entityMatches.length > 0) return entityMatches;

  return profiles.filter((profile) => {
    const description = profile && typeof profile === "object"
      ? (profile as { description?: unknown }).description
      : undefined;
    if (typeof description !== "string") return false;
    return description.toLowerCase().split(/[,\s/，、]+/).filter(Boolean).some((term) => includesTerm(normalized, term));
  });
}

function profileTerms(profile: unknown, key: "examples" | "entities"): string[] {
  if (!profile || typeof profile !== "object") return [];
  const value = (profile as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function profileId(profile: unknown): string[] {
  if (!profile || typeof profile !== "object") return [];
  const id = (profile as { id?: unknown }).id;
  return typeof id === "string" ? [id] : [];
}

function routeDecision(action: string, targetWorkflowIds: string[], suspendedWorkflowIds: string[]): unknown {
  return {
    action,
    targetWorkflowIds,
    suspendedWorkflowIds,
    confidence: 0.95,
    reason: "unit-test route decision",
  };
}

function includesTerm(message: string, term: string): boolean {
  const lowered = term.toLowerCase();
  return lowered.length >= 2 && message.includes(lowered);
}

function isTraceReason(detail: unknown, reason: string): boolean {
  return Boolean(
    detail &&
    typeof detail === "object" &&
    "reason" in detail &&
    (detail as { reason?: unknown }).reason === reason,
  );
}
