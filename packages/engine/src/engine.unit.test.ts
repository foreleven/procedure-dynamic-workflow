import assert from "node:assert/strict";
import test from "node:test";
import {
  ToolMessage,
  createConnectorRegistry,
  definePatch,
  defineRouting,
  type WorkflowDefinition,
  type WorkflowMessage,
  workflow,
  z,
} from "@pac/workflow";
import { WorkflowEngine } from "./engine.js";
import type { LlmClient, LlmStructuredRequest, LlmTextRequest } from "./llm/client.js";
import { EngineInvokeResult, EngineStreamPayload, EngineTraceEvent, WorkflowDefinitionInput } from "./types.js";

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

interface RollbackState {
  selected: string | null;
  runs: number;
}

interface LoopResearchState {
  researchQuestions: string[];
  candidate: string | null;
  status: "collecting" | "ready";
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

  const result = await engine.invoke("unrelated request", session);

  assert.equal(primaryText(result), "我还不能确定要执行哪个 workflow。");
  assert.deepEqual(assistantWorkflowIds(result), []);
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

  const result = await engine.invoke("please route me", session);

  assert.equal(primaryText(result), "我还不能确定要执行哪个 workflow。");
  assert.deepEqual(assistantWorkflowIds(result), []);
  assert.deepEqual(session.activeWorkflowIds, []);
  assert.equal(routeCallCount(llm), 1);
  assert.equal(patchCallCount(llm), 0);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.none"));
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

  const result = await engine.invoke("please route me", session);

  assert.equal(primaryText(result), "我还不能确定要执行哪个 workflow。");
  assert.deepEqual(assistantWorkflowIds(result), []);
  assert.deepEqual(session.activeWorkflowIds, []);
  assert.equal(routeCallCount(llm), 1);
  assert.equal(patchCallCount(llm), 0);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.none"));
});

test("WorkflowEngine fail-closes malformed custom router output without mutating session", async () => {
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: { selected: "should-not-run" } }),
      connectors: createConnectorRegistry(),
    },
    routing: {
      router: {
        async route(input) {
          input.session.facts.leaked = { nested: true };
          input.session.activeWorkflowIds.push("missing_flow");
          return {
            action: "switch",
            targetWorkflowIds: ["missing_flow"],
            suspendedWorkflowIds: [],
          };
        },
      },
    },
  });
  const session = engine.createSession({
    sessionId: "session_custom_router_unknown",
    userId: "user_custom_router_unknown",
  });

  const result = await engine.invoke("custom route me", session);

  assert.equal(primaryText(result), "我还不能确定要执行哪个 workflow。");
  assert.deepEqual(session.activeWorkflowIds, []);
  assert.deepEqual(session.facts, {});
  assert.equal(engine.getWorkflowSnapshot<TestState>(session, "test_flow"), undefined);
  assert.ok(traceEvents(result).some((trace) =>
    trace.phase === "routing.none" &&
    isNestedTraceReason(trace.detail, "unknown_workflow_ids"),
  ));
});

test("WorkflowEngine treats continue routing as all active workflows", async () => {
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow(), createCompetingWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: { selected: "active" } }),
      connectors: createConnectorRegistry(),
    },
    routing: {
      router: {
        async route() {
          return {
            action: "continue",
            targetWorkflowIds: ["test_flow"],
            suspendedWorkflowIds: [],
          };
        },
      },
    },
  });
  const session = engine.createSession({
    sessionId: "session_continue_all_active",
    userId: "user_continue_all_active",
    activeWorkflowIds: ["test_flow", "competing_flow"],
  });

  const result = await engine.invoke("continue one active workflow", session);

  assert.deepEqual([...assistantWorkflowIds(result)].sort(), ["competing_flow", "test_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow", "competing_flow"]);
  assert.deepEqual(session.routingMemory.lastMatchedWorkflowIds, ["test_flow", "competing_flow"]);
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

  const result = await engine.invoke("please route me", session);
  const instance = engine.getWorkflowSnapshot<TestState>(session, "test_flow");

  assert.equal(primaryText(result), "selected=picked; dependent=default-dependent; derived=picked:loaded:true");
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
    content: primaryText(result),
  });
  assert.equal(patchCallCount(llm), 1);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.gate.new_session" && trace.workflowId === "engine"));
  assert.ok(traceEvents(result).some((trace) => trace.phase === "invalidate"));
});

test("WorkflowEngine runs loop planner states, loop effects, and loop completion dependencies", async () => {
  const llm = createLoopResearchLlm([
    {
      status: "continue",
      reason: "Search for direct competitors first.",
      state: { query: "alpha competitors" },
    },
    {
      status: "satisfied",
      reason: "Candidate evidence is enough for this bounded pass.",
      state: null,
    },
  ]);
  const engine = new WorkflowEngine({
    workflows: [createLoopResearchWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
    routing: {
      router: {
        async route() {
          return {
            action: "continue",
            targetWorkflowIds: ["loop_research_flow"],
            suspendedWorkflowIds: [],
          };
        },
      },
    },
  });
  const session = engine.createSession({
    sessionId: "session_loop_research",
    userId: "user_loop_research",
    activeWorkflowIds: ["loop_research_flow"],
  });

  const result = await engine.invoke("research alpha", session);
  const instance = engine.getWorkflowSnapshot<LoopResearchState>(session, "loop_research_flow");

  assert.equal(primaryText(result), "candidate=alpha competitors; status=ready");
  assert.deepEqual(instance?.state.researchQuestions, ["research alpha"]);
  assert.equal(instance?.state.candidate, "alpha competitors");
  assert.equal(instance?.state.status, "ready");
  assert.equal(loopCallCount(llm, "loop_research_flow_research_loop_state"), 2);
  assert.ok(instance?.state.messages.some((message) =>
    message.role === "tool" &&
    message.name === "loop.research.state"
  ));
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

  const result = await engine.invoke("please route me to competitor", session);

  assert.deepEqual(assistantWorkflowIds(result), ["test_flow", "competing_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow", "competing_flow"]);
  assert.equal(patchCallCount(llm), 2);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.gate.new_session" && trace.workflowId === "engine"));
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

  const result = await engine.invoke("please route me", session);

  assert.deepEqual(assistantWorkflowIds(result), []);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow"]);
  assert.equal(patchCallCount(llm), 1);
  assert.ok(!assistantWorkflowIds(result).includes("weak_route_flow"));
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

  await engine.invoke("please route me", session);
  const snapshot = engine.getWorkflowSnapshot<TestState>(session, "test_flow");
  assert.ok(snapshot);
  assert.equal("workflowInstances" in session, false);

  snapshot.state.selected = "mutated";
  snapshot.prefetch.baseline = "mutated";

  const nextSnapshot = engine.getWorkflowSnapshot<TestState>(session, "test_flow");
  assert.equal(nextSnapshot?.state.selected, "picked");
  assert.deepEqual(nextSnapshot?.prefetch, { baseline: "loaded" });
});

test("WorkflowEngine keeps session messages authoritative and preserves existing message metadata", async () => {
  const priorMessage = {
    role: "assistant",
    id: "server-message-1",
    content: "Existing cached answer",
    responseId: "response-1",
  } satisfies WorkflowMessage;
  const llm = createPatchLlm({ statePatch: { selected: "picked" } });
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_authoritative_messages",
    userId: "user_authoritative_messages",
    messages: [priorMessage],
  });

  await engine.invoke("please route me", session);
  const snapshot = engine.getWorkflowSnapshot<TestState>(session, "test_flow");

  assert.deepEqual(session.messages[0], priorMessage);
  assert.equal(session.messages.at(-1)?.role, "assistant");
  assert.deepEqual(snapshot?.state.messages, session.messages);
  const patchRequest = llm.structuredCalls.find(
    (call): call is LlmTextRequest =>
      Boolean(call && typeof call === "object" && (call as { name?: unknown }).name === "test_flow_patch"),
  );
  const providerPriorMessage = patchRequest?.messages.find((item) =>
    item.role === "assistant" && assistantText(item).includes("Existing cached answer")
  );
  assert.equal(providerPriorMessage?.role, "assistant");
  if (providerPriorMessage?.role !== "assistant") {
    throw new Error("Expected prior assistant message in patch request");
  }
  assert.equal(providerPriorMessage.responseId, "response-1");
  assert.deepEqual(providerPriorMessage.content[0], {
    type: "text",
    text: "Existing cached answer",
    textSignature: "server-message-1",
  });
});

test("WorkflowEngine preserves caller supplied user message metadata", async () => {
  const fixedNow = new Date("2026-03-04T05:06:07.008Z");
  const suppliedTimestamp = fixedNow.getTime() - 1000;
  const llm = createPatchLlm({ statePatch: { selected: "picked" } });
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
      now: () => fixedNow,
    },
  });
  const session = engine.createSession({
    sessionId: "session_user_message_metadata",
    userId: "user_message_metadata",
  });

  await engine.invoke({
    role: "user",
    id: "user-message-1",
    content: "please route me",
    timestamp: suppliedTimestamp,
  }, session);

  assert.deepEqual(session.messages[0], {
    role: "user",
    id: "user-message-1",
    content: "please route me",
    timestamp: suppliedTimestamp,
  });
  const patchRequest = structuredRequestNamed(llm.structuredCalls, "test_flow_patch");
  assert.equal(patchRequest?.messages[0]?.timestamp, suppliedTimestamp);
});

test("WorkflowEngine isolates workflow-local message objects from session history", async () => {
  const engine = new WorkflowEngine({
    workflows: [createMessageMutationWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_message_object_isolation",
    userId: "user_message_object_isolation",
    activeWorkflowIds: ["message_mutation_flow"],
    messages: [{
      role: "assistant",
      id: "prior-message",
      content: "Original history",
    }],
  });

  await engine.invoke("mutate local history", session);

  assert.deepEqual(session.messages[0], {
    role: "assistant",
    id: "prior-message",
    content: "Original history",
  });
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

  const result = await engine.invoke("run optional invalidation", session);
  const instance = engine.getWorkflowSnapshot<OptionalInvalidationState>(session, "optional_invalidation_flow");

  assert.equal(primaryText(result), "hasOptional=false; value=missing");
  assert.equal("optionalDerived" in (instance?.state ?? {}), false);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "invalidate"));
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

  const result = await engine.invoke("set dependent and derive source", session);
  const instance = engine.getWorkflowSnapshot<SameTurnInvalidationState>(session, "same_turn_invalidation_flow");

  assert.equal(primaryText(result), "source=derived-source; dependent=explicit-dependent");
  assert.equal(instance?.state.source, "derived-source");
  assert.equal(instance?.state.dependent, "explicit-dependent");
  assert.ok(!traceEvents(result).some((trace) => trace.phase === "invalidate"));
});

test("WorkflowEngine ignores state patch writes to reserved runtime messages", async () => {
  const fixedNow = new Date("2026-04-05T06:07:08.009Z");
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
      now: () => fixedNow,
    },
  });
  const session = engine.createSession({ sessionId: "session_reserved_messages", userId: "user_reserved_messages" });

  const result = await engine.invoke("please route me", session);
  const instance = engine.getWorkflowSnapshot<TestState>(session, "reserved_messages_patch_flow");

  assert.equal(primaryText(result), "selected=picked; messages=3");
  assert.deepEqual(instance?.state.messages, [
    { role: "user", content: "please route me", timestamp: fixedNow.getTime() },
    { role: "tool", name: "load_baseline", call: { stage: "beforePatch" }, result: { baseline: "loaded" } },
    {
      role: "tool",
      name: "reserved_messages_patch_flow.patch",
      call: { stage: "patch", workflowId: "reserved_messages_patch_flow" },
      result: { statePatch: { selected: "picked" } },
    },
    { role: "assistant", content: "selected=picked; messages=3" },
  ]);
  assert.deepEqual(session.messages, instance?.state.messages);
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
    engine.invoke("bad function render", session),
    /Workflow bad_function_render_flow render\.text must be a string/,
  );
});

test("WorkflowEngine discards function render runtime mutations", async () => {
  const engine = new WorkflowEngine({
    workflows: [createRenderMutationWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_render_mutation",
    userId: "user_render_mutation",
    activeWorkflowIds: ["render_mutation_flow"],
  });

  const result = await engine.invoke("render should not mutate", session);
  const snapshot = engine.getWorkflowSnapshot<{ done: boolean; renderTouched?: boolean | undefined }>(
    session,
    "render_mutation_flow",
  );

  assert.equal(primaryText(result), "render mutation ignored");
  assert.equal(snapshot?.state.done, true);
  assert.equal(snapshot?.state.renderTouched, undefined);
  assert.equal(snapshot?.context.nodeTouched, true);
  assert.equal(snapshot?.context.renderTouched, undefined);
  assert.equal(snapshot?.prefetch.nodeTouched, true);
  assert.equal(snapshot?.prefetch.renderTouched, undefined);
  assert.equal(session.sharedCache.has("renderTouched"), false);
});

test("WorkflowEngine rolls back routed workflow lifecycle when a turn fails", async () => {
  const engine = new WorkflowEngine({
    workflows: [createRollbackWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: { selected: "beta" } }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_rollback_new",
    userId: "user_rollback_new",
  });
  session.sharedCache.set("kept", "yes");

  await assert.rejects(
    engine.invoke("please rollback fail", session),
    /rollback render failed/,
  );

  assert.deepEqual(session.activeWorkflowIds, []);
  assert.deepEqual(session.messages, []);
  assert.deepEqual([...session.sharedCache.entries()], [["kept", "yes"]]);
  assert.deepEqual(session.routingMemory, { lastMatchedWorkflowIds: [] });
  assert.equal(engine.getWorkflowSnapshot<RollbackState>(session, "rollback_flow"), undefined);
});

test("WorkflowEngine rolls back active workflow runtime and dependency memory when a turn fails", async () => {
  const llm = createSequentialPatchLlm([
    { statePatch: { selected: "alpha" } },
    { statePatch: { selected: "beta" } },
    { statePatch: { selected: "beta" } },
  ]);
  const engine = new WorkflowEngine({
    workflows: [createRollbackWorkflow({ id: "rollback_active_flow" })],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_rollback_active",
    userId: "user_rollback_active",
    activeWorkflowIds: ["rollback_active_flow"],
  });

  const first = await engine.invoke("select alpha", session);
  const beforeFailure = engine.getWorkflowSnapshot<RollbackState>(session, "rollback_active_flow");
  assert.ok(beforeFailure);
  assert.equal(primaryText(first), "selected=alpha; runs=1");
  assert.deepEqual(beforeFailure.context, { lastSelected: "alpha" });
  assert.deepEqual(beforeFailure.prefetch, { lastMessage: "select alpha" });
  assert.deepEqual([...session.sharedCache.entries()], [["lastSelected", "alpha"]]);
  const routingMemoryBeforeFailure = { ...session.routingMemory };

  await assert.rejects(
    engine.invoke("fail with beta", session),
    /rollback render failed/,
  );

  const afterFailure = engine.getWorkflowSnapshot<RollbackState>(session, "rollback_active_flow");
  assert.deepEqual(afterFailure, beforeFailure);
  assert.deepEqual(session.messages, beforeFailure.state.messages);
  assert.deepEqual([...session.sharedCache.entries()], [["lastSelected", "alpha"]]);
  assert.deepEqual(session.routingMemory, routingMemoryBeforeFailure);

  const recovered = await engine.invoke("recover beta", session);
  const afterRecovery = engine.getWorkflowSnapshot<RollbackState>(session, "rollback_active_flow");

  assert.equal(primaryText(recovered), "selected=beta; runs=2");
  assert.equal(afterRecovery?.state.selected, "beta");
  assert.equal(afterRecovery?.state.runs, 2);
  assert.deepEqual(afterRecovery?.context, { lastSelected: "beta" });
  assert.deepEqual(afterRecovery?.prefetch, { lastMessage: "recover beta" });
  assert.deepEqual([...session.sharedCache.entries()], [["lastSelected", "beta"]]);
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
    engineWithArrayPrefetch.invoke(
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
    engineWithBlankPrefetchKey.invoke(
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
  });
  const session = engine.createSession({ sessionId: "session_3", userId: "user_3" });

  const { result, payloads } = await collectStream(engine.stream("please stream", session));
  const instance = engine.getWorkflowSnapshot<TestState>(session, "stream_flow");

  assert.equal(primaryText(result), "hello world");
  assert.deepEqual(assistantDeltaSignatures(payloads), [
    "stream_flow|:hello",
    "stream_flow|: ",
    "stream_flow|:world",
  ]);
  assert.deepEqual(assistantMessageContents(payloads), ["hello world"]);
  assert.deepEqual(instance?.state.messages.at(-1), {
    role: "assistant",
    content: "hello world",
  });
  assert.equal(llm.streamCalls.length, 1);
  const streamRequest = llm.streamCalls[0] as LlmTextRequest | undefined;
  assert.ok(streamRequest);
  const patchFact = streamRequest.messages.find((item) =>
    item.role === "assistant" && assistantText(item).includes("Runtime tool fact: stream_flow.patch")
  );
  assert.ok(patchFact);
  assert.match(assistantText(patchFact), /"selected": "streamed"/);
  assert.equal(llm.textCalls.length, 0);
});

test("WorkflowEngine stream return stops iteration while turn execution completes", async () => {
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
  });
  const session = engine.createSession({ sessionId: "session_stream_return", userId: "user_stream_return" });
  const stream = engine.stream("please stream", session);
  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  await iterator.return?.();

  const afterReturn = await iterator.next();

  assert.deepEqual(afterReturn, { done: true, value: undefined });
  await eventually(() => {
    assert.deepEqual(session.messages.at(-1), {
      role: "assistant",
      content: "hello world",
    });
  });
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

  const result = await engine.invoke("show available slot", session);

  assert.equal(primaryText(result), "rendered from tool history");
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

  const firstStream = await collectStream(engine.stream("select alpha", session));
  const first = firstStream.result;
  const second = await engine.invoke("repeat without change", session);
  const third = await engine.invoke("select alpha again", session);
  const fourth = await engine.invoke("select beta", session);
  const instance = engine.getWorkflowSnapshot<EffectDependencyState>(session, "effect_dependency_flow");

  assert.equal(instance?.state.selected, "beta");
  assert.equal(instance?.state.runs, 2);
  assert.equal(primaryText(first), "selected=alpha; runs=1");
  assert.equal(primaryText(second), "selected=alpha; runs=1");
  assert.equal(primaryText(third), "selected=alpha; runs=1");
  assert.equal(primaryText(fourth), "selected=beta; runs=2");
  assert.equal(traceEvents(first).filter((trace) => trace.phase === "node.step.start").length, 2);
  assert.equal(traceEvents(first).filter((trace) => trace.phase === "node.step.end").length, 2);
  assert.ok(firstStream.payloads.some((payload) =>
    "event" in payload &&
    payload.event.type === "engine.trace" &&
    payload.event.trace.phase === "node.step.start",
  ));
  assert.deepEqual(workflowStepEventTypes(firstStream.payloads), [
    "workflow.step.progress",
    "workflow.step.start",
    "workflow.step.start",
    "workflow.step.end",
    "workflow.step.end",
  ]);
  assert.ok(traceEvents(second).some((trace) =>
    trace.phase === "node.afterPatch.load_selected.skip" &&
    isTraceReason(trace.detail, "dependencies"),
  ));
  assert.equal(traceEvents(second).filter((trace) => trace.phase === "node.step.start").length, 0);
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
    engine.invoke("bad llm text", session),
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
  });
  const session = engine.createSession({
    sessionId: "session_bad_stream_event",
    userId: "user_bad_stream_event",
    activeWorkflowIds: ["bad_stream_event_flow"],
  });

  await assert.rejects(
    engine.invoke("bad stream event", session),
    /Workflow bad_stream_event_flow streamText text_delta\.delta must be a string/,
  );
});

test("WorkflowEngine uses deps.now for routing, patch prompt, and engine-created user messages", async () => {
  const fixedNow = new Date("2026-02-03T04:05:06.789Z");
  const llm = createNamedStreamingLlm({
    patch: { statePatch: { selected: "clocked" } },
    streams: {
      clock_flow_render: {
        deltas: [],
        finalText: "clocked response",
      },
    },
  });
  const engine = new WorkflowEngine({
    workflows: [createStreamingWorkflow({
      id: "clock_flow",
      renderName: "clock_flow_render",
      route: "clock",
    })],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
      now: () => fixedNow,
    },
  });
  const session = engine.createSession({
    sessionId: "session_clock",
    userId: "user_clock",
  });

  await engine.invoke("please clock", session);

  const routeRequest = structuredRequestNamed(llm.structuredCalls, "workflow_route");
  const patchRequest = structuredRequestNamed(llm.structuredCalls, "clock_flow_patch");
  const renderRequest = llm.streamRequests.find((request) => request.name === "clock_flow_render");

  assert.equal(routeRequest?.messages[0]?.timestamp, fixedNow.getTime());
  assert.match(patchRequest?.instruction ?? "", /Current time is 2026-02-03T04:05:06\.789Z/);
  assert.equal(patchRequest?.messages[0]?.timestamp, fixedNow.getTime());
  assert.equal(renderRequest?.messages[0]?.timestamp, fixedNow.getTime());
});

test("WorkflowEngine merges completed LLM workflow responses by default", async () => {
  const llm = createNamedStreamingLlm({
    patch: { statePatch: { selected: "multi" } },
    streams: {
      stream_a_render: {
        deltas: ["alpha response"],
        finalText: "alpha response",
      },
      stream_b_render: {
        deltas: ["beta response"],
        finalText: "beta response",
      },
      merged_response: {
        deltas: ["merged", " reply"],
        finalText: "merged reply",
      },
    },
  });
  const engine = new WorkflowEngine({
    workflows: [
      createToolStreamingWorkflow({
        id: "stream_a",
        renderName: "stream_a_render",
        route: "alpha",
        toolName: "connectors.alpha",
        result: { portfolio: "growth" },
      }),
      createToolStreamingWorkflow({
        id: "stream_b",
        renderName: "stream_b_render",
        route: "beta",
        toolName: "connectors.beta",
        result: { risk: "moderate" },
      }),
    ],
    deps: {
      llm,
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_streams",
    userId: "user_streams",
    activeWorkflowIds: ["stream_a", "stream_b"],
  });

  const { result, payloads } = await collectStream(engine.stream("message for active workflows", session));
  const streamA = engine.getWorkflowSnapshot<{ loaded: boolean }>(session, "stream_a");
  const streamB = engine.getWorkflowSnapshot<{ loaded: boolean }>(session, "stream_b");

  assert.deepEqual(assistantWorkflowIds(result), []);
  assert.equal(primaryText(result), "merged reply");
  assert.deepEqual(assistantTexts(result), ["merged reply"]);
  const deltas = assistantDeltaSignatures(payloads);
  assert.deepEqual(deltas.filter((delta) => delta.startsWith("stream_a+stream_b|")), [
    "stream_a+stream_b|stream_a+stream_b:merged",
    "stream_a+stream_b|stream_a+stream_b: reply",
  ]);
  assert.ok(!deltas.some((delta) => delta.startsWith("stream_a|")));
  assert.ok(!deltas.some((delta) => delta.startsWith("stream_b|")));
  assert.deepEqual(llm.streamCalls, ["stream_a_render", "stream_b_render", "merged_response"]);
  const streamARequest = llm.streamRequests.find((request) => request.name === "stream_a_render");
  const streamBRequest = llm.streamRequests.find((request) => request.name === "stream_b_render");
  const mergeRequest = llm.streamRequests.find((request) => request.name === "merged_response");
  assert.ok(mergeRequest);
  assert.ok(streamARequest);
  assert.ok(streamBRequest);
  const streamAFact = streamARequest.messages.find((item) =>
    item.role === "assistant" && assistantText(item).includes("Runtime tool fact: connectors.alpha")
  );
  const streamBFact = streamBRequest.messages.find((item) =>
    item.role === "assistant" && assistantText(item).includes("Runtime tool fact: connectors.beta")
  );
  assert.match(assistantText(streamAFact), /"portfolio": "growth"/);
  assert.match(assistantText(streamBFact), /"risk": "moderate"/);
  assert.match(mergeRequest.instruction, /Several workflow instances independently completed/);
  assert.match(mergeRequest.instruction, /alpha response/);
  assert.match(mergeRequest.instruction, /beta response/);
  assert.deepEqual(streamA?.state.messages.map((message) => message.role), ["user", "tool", "assistant"]);
  assert.deepEqual(streamB?.state.messages.map((message) => message.role), ["user", "tool", "assistant"]);
  assert.notDeepEqual(session.messages, streamA?.state.messages);
  assert.notDeepEqual(streamA?.state.messages, streamB?.state.messages);
  assert.equal(streamA?.state.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(streamB?.state.messages.filter((message) => message.role === "assistant").length, 1);
  assert.deepEqual(streamA?.state.messages.at(-1), {
    role: "assistant",
    content: "alpha response",
  });
  assert.deepEqual(streamB?.state.messages.at(-1), {
    role: "assistant",
    content: "beta response",
  });
  assert.deepEqual(session.messages.at(-1), {
    role: "assistant",
    content: "merged reply",
  });
  assert.deepEqual(assistantMessageContents(payloads), ["merged reply"]);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "response.merge" && trace.workflowId === "engine"));
});

test("WorkflowEngine can render active LLM workflows separately through merge strategy", async () => {
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
    render: {
      mergeStrategy: () => "separate",
    },
  });
  const session = engine.createSession({
    sessionId: "session_separate_streams",
    userId: "user_separate_streams",
    activeWorkflowIds: ["stream_a", "stream_b"],
  });

  const { result, payloads } = await collectStream(engine.stream("message for active workflows", session));

  assert.deepEqual(assistantWorkflowIds(result), ["stream_b", "stream_a"]);
  assert.equal(primaryText(result), "b1b2");
  assert.deepEqual(assistantTexts(result), ["b1b2", "a1a2"]);
  assert.deepEqual(assistantDeltaSignatures(payloads), [
    "stream_b|:b1",
    "stream_b|:b2",
    "stream_a|:a1",
    "stream_a|:a2",
  ]);
  assert.deepEqual(llm.streamCalls, ["stream_a_render", "stream_b_render"]);
});

test("WorkflowEngine passes merge strategy a session snapshot", async () => {
  const llm = createNamedStreamingLlm({
    patch: { statePatch: { selected: "multi" } },
    streams: {
      stream_a_render: {
        deltas: ["a"],
        finalText: "alpha",
      },
      stream_b_render: {
        deltas: ["b"],
        finalText: "beta",
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
    render: {
      mergeStrategy: ({ session }) => {
        session.activeWorkflowIds.push("leaked_flow");
        session.messages.push({ role: "assistant", content: "leaked response" });
        session.facts.leaked = true;
        return "separate";
      },
    },
  });
  const session = engine.createSession({
    sessionId: "session_merge_strategy_snapshot",
    userId: "user_merge_strategy_snapshot",
    activeWorkflowIds: ["stream_a", "stream_b"],
  });

  const result = await engine.invoke("message for active workflows", session);

  assert.deepEqual(assistantTexts(result), ["alpha", "beta"]);
  assert.deepEqual(session.activeWorkflowIds, ["stream_a", "stream_b"]);
  assert.deepEqual(session.facts, {});
  assert.ok(!session.messages.some((message) => message.role === "assistant" && message.content === "leaked response"));
});

test("WorkflowEngine emits separate function-render messages as each workflow completes", async () => {
  const engine = new WorkflowEngine({
    workflows: [
      createDelayedFunctionRenderWorkflow("function_slow", "slow", 12),
      createDelayedFunctionRenderWorkflow("function_fast", "fast", 1),
    ],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_function_render_order",
    userId: "user_function_render_order",
    activeWorkflowIds: ["function_slow", "function_fast"],
  });

  const { result, payloads } = await collectStream(engine.stream("run both function renders", session));

  assert.deepEqual(assistantMessageContents(payloads), ["function_fast done", "function_slow done"]);
  assert.deepEqual(assistantTexts(result), ["function_fast done", "function_slow done"]);
  assert.deepEqual(assistantWorkflowIds(result), ["function_fast", "function_slow"]);
  assert.deepEqual(session.messages.slice(-2), result.messages);
});

test("WorkflowEngine waits for concurrent workflow tasks before rollback", async () => {
  const engine = new WorkflowEngine({
    workflows: [
      createConcurrentRollbackWorkflow("rollback_slow_success", 15, false),
      createConcurrentRollbackWorkflow("rollback_fast_failure", 1, true),
    ],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_concurrent_rollback",
    userId: "user_concurrent_rollback",
    activeWorkflowIds: ["rollback_slow_success", "rollback_fast_failure"],
  });

  await assert.rejects(
    engine.invoke("run concurrent rollback", session),
    /rollback_fast_failure failed/,
  );
  await delay(25);

  const slow = engine.getWorkflowSnapshot<{ done: boolean }>(session, "rollback_slow_success");
  const fast = engine.getWorkflowSnapshot<{ done: boolean }>(session, "rollback_fast_failure");

  assert.equal(slow?.state.done, false);
  assert.equal(fast?.state.done, false);
  assert.deepEqual(session.messages, []);
});

test("WorkflowEngine rolls back provisional separate stream output when a later workflow fails", async () => {
  const engine = new WorkflowEngine({
    workflows: [
      createConcurrentRollbackWorkflow("rollback_fast_success", 1, false),
      createConcurrentRollbackWorkflow("rollback_slow_failure", 15, true),
    ],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });
  const session = engine.createSession({
    sessionId: "session_provisional_stream_rollback",
    userId: "user_provisional_stream_rollback",
    activeWorkflowIds: ["rollback_fast_success", "rollback_slow_failure"],
  });
  const payloads: EngineStreamPayload[] = [];

  await assert.rejects(
    async () => {
      for await (const payload of engine.stream("run provisional rollback", session)) {
        payloads.push(payload);
      }
    },
    /rollback_slow_failure failed/,
  );
  await delay(25);

  const fast = engine.getWorkflowSnapshot<{ done: boolean }>(session, "rollback_fast_success");
  const slow = engine.getWorkflowSnapshot<{ done: boolean }>(session, "rollback_slow_failure");

  assert.deepEqual(assistantMessageContents(payloads), ["rollback_fast_success done"]);
  assert.equal(fast?.state.done, false);
  assert.equal(slow?.state.done, false);
  assert.deepEqual(session.messages, []);
  assert.ok(!payloads.some((payload) =>
    "event" in payload &&
    payload.event.type === "engine.turn.done",
  ));
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

  await engine.invoke("run both", session);

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

  const result = await engine.invoke("any active message", session);
  const instance = engine.getWorkflowSnapshot<{ count: number }>(session, "round_flow");

  assert.equal(primaryText(result), "count=2");
  assert.equal(instance?.state.count, 2);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "nodes.afterPatch.maxRounds"));
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

  const result = await engine.invoke("please competitor", session);
  const activeInstance = engine.getWorkflowSnapshot<TestState>(session, "test_flow");
  const competingInstance = engine.getWorkflowSnapshot<TestState>(session, "competing_flow");

  assert.deepEqual(assistantWorkflowIds(result), []);
  assert.deepEqual(session.activeWorkflowIds, ["competing_flow"]);
  assert.deepEqual(session.routingMemory.suspendedWorkflowIds, ["test_flow"]);
  assert.equal(activeInstance?.state.selected, null);
  assert.equal(competingInstance?.state.selected, "active");
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.switch"));
  assert.equal(patchCallCount(llm), 1);
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

  const result = await engine.invoke("also competitor", session);

  assert.deepEqual(assistantWorkflowIds(result), ["test_flow", "competing_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow", "competing_flow"]);
  assert.equal(session.routingMemory.suspendedWorkflowIds, undefined);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.parallel"));
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

  await engine.invoke("start ack", session);
  const routeCallsAfterFirstTurn = routeCallCount(llm);
  const result = await engine.invoke("确认", session);

  assert.equal(routeCallCount(llm), routeCallsAfterFirstTurn);
  assert.deepEqual(assistantWorkflowIds(result), []);
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.protocol_fast_path"));
  assert.ok(traceEvents(result).some((trace) => trace.phase === "routing.continue"));
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

test("WorkflowEngine validates invoke input and active workflow ids", async () => {
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
    engine.invoke("", session),
    /Invalid message: message must be a non-empty string/,
  );
  session.activeWorkflowIds.push("missing_flow");
  await assert.rejects(
    engine.invoke("route me", session),
    /unknown active workflow id\(s\): missing_flow/,
  );

  session.activeWorkflowIds.pop();
  session.activeWorkflowIds.push("test_flow");
  await assert.rejects(
    engine.invoke("route me", session),
    /duplicate active workflow id: test_flow/,
  );
});

test("WorkflowEngine rejects runtime workflow state invariants during construction", () => {
  const workflow = createTestWorkflow();
  const firstNode = workflow.nodes[0];
  assert.ok(firstNode);

  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        id: "",
      }),
    /Workflow definition id must be a non-empty string/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        routing: {
          ...workflow.routing,
          thresholds: {
            ...workflow.routing.thresholds,
            localAccept: 2,
          },
        },
      }),
    /Workflow test_flow routing\.thresholds\.localAccept must be a finite number between 0 and 1/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        nodes: [
          firstNode,
          firstNode,
        ],
      }),
    /Workflow test_flow nodes contains duplicate node name/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        render: {
          name: "bad_render",
          instruction: "Reply.",
          progress: "",
        },
      }),
    /Workflow test_flow render\.progress must be a non-empty string/,
  );
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

  const result = await engine.invoke("diagnose", session);

  assert.equal(primaryText(result), "diagnostic ok");
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

function createLoopResearchWorkflow(): WorkflowDefinition<LoopResearchState> {
  const program = workflow<LoopResearchState>({
    id: "loop_research_flow",
    version: "0.1.0",
    description: "Loop research workflow for engine coverage.",
    routing: defineRouting({
      examples: ["research alpha"],
      entities: ["research"],
      neighbors: [],
    }),
    stateSchema: z.object({
      researchQuestions: z.array(z.string()),
      candidate: z.string().nullable(),
      status: z.enum(["collecting", "ready"]),
    }),
    state: {
      researchQuestions: [],
      candidate: null,
      status: "collecting",
    },
  });

  program.patch({
    state: {
      researchQuestions: z.array(z.string()),
    },
  });

  const researchLoop = program.loop("research", {
    description: "Plans and executes bounded research passes for a candidate.",
    dependsOn: ["researchQuestions"],
    maxRuns: 2,
    stateSchema: z.object({
      query: z.string(),
    }),
    instruction: "Use prior evidence to decide the next research query or stop.",
  });

  researchLoop.effect("store_candidate", ["loop.state"], {
    description: "Stores a compact handoff candidate from the current loop state.",
    run: (_state, _context, runtime) => ({
      candidate: runtime.loop.state.query,
      messages: [
        new ToolMessage({
          name: "test.loopCandidate",
          call: { run: runtime.loop.run },
          result: { query: runtime.loop.state.query },
        }),
      ],
    }),
  });

  program.effect("mark_ready", ["loop.research"], {
    description: "Marks the workflow ready only after the loop has stopped.",
    run: () => ({
      status: "ready",
    }),
  });

  return program.render({
    name: "loop_research_render",
    progress: "Rendering loop research",
    instruction: "Render loop research state.",
  });
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

function createMessageMutationWorkflow(): WorkflowDefinition<{ done: boolean }> {
  return {
    id: "message_mutation_flow",
    version: "0.1.0",
    description: "Message mutation isolation test fixture.",
    routing: defineRouting({
      examples: ["mutate local history"],
      entities: ["mutate"],
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
        name: "mutate_local_message",
        stage: "afterPatch",
        description: "Mutates workflow-local message history so session message ownership is observable.",
        run: ({ state }) => {
          const firstMessage = state.messages[0];
          if (firstMessage?.role === "assistant") {
            firstMessage.content = "mutated local history";
          }

          return { state: { done: true } };
        },
      },
    ],
    render: () => ({
      text: "message isolation ok",
    }),
  };
}

function createRenderMutationWorkflow(): WorkflowDefinition<{ done: boolean; renderTouched?: boolean | undefined }> {
  return {
    id: "render_mutation_flow",
    version: "0.1.0",
    description: "Render mutation isolation test fixture.",
    routing: defineRouting({
      examples: ["render should not mutate"],
      entities: ["render"],
      neighbors: [],
    }),
    stateSchema: z.object({
      done: z.boolean(),
      renderTouched: z.boolean().optional(),
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
        name: "prepare_render",
        stage: "afterPatch",
        description: "Writes legitimate pre-render runtime values that render must not override.",
        run: ({ context, prefetch }) => {
          context.set("nodeTouched", true);
          prefetch.set("nodeTouched", true);
          return { state: { done: true } };
        },
      },
    ],
    render: ({ state, context, prefetch, session }) => {
      state.done = false;
      state.renderTouched = true;
      context.set("renderTouched", true);
      prefetch.set("renderTouched", true);
      session.sharedCache.set("renderTouched", true);
      return {
        text: "render mutation ignored",
      };
    },
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

function createToolStreamingWorkflow(config: {
  id: string;
  renderName: string;
  route: string;
  toolName: string;
  result: Record<string, unknown>;
}): WorkflowDefinition<{ loaded: boolean }> {
  const program = workflow({
    id: config.id,
    version: "0.1.0",
    description: `${config.id} tool render workflow fixture.`,
    routing: defineRouting({
      examples: [config.route],
      entities: [config.route],
      neighbors: [],
    }),
    stateSchema: z.object({
      loaded: z.boolean(),
    }),
    state: {
      loaded: false,
    },
  });

  program.patch({ state: {} });
  program.effect("load_tool_fact", {
    description: "Appends one current-turn tool fact so the workflow-local renderer can use connector facts.",
    run: (state) => {
      if (state.loaded) return {};
      return {
        loaded: true,
        messages: [
          new ToolMessage({
            name: config.toolName,
            call: { route: config.route },
            result: config.result,
          }),
        ],
      };
    },
  });

  return program.render({
    name: config.renderName,
    instruction: "Stream the final response.",
    progress: "Streaming response",
  });
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

function createDelayedFunctionRenderWorkflow(
  id: string,
  route: string,
  renderDelayMs: number,
): WorkflowDefinition<{ done: boolean }> {
  return {
    id,
    version: "0.1.0",
    description: `${id} delayed function render fixture.`,
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
        name: "mark_done",
        stage: "afterPatch",
        description: "Marks the workflow done before the delayed function render.",
        run: () => ({ state: { done: true } }),
      },
    ],
    render: async () => {
      await delay(renderDelayMs);
      return {
        text: `${id} done`,
      };
    },
  };
}

function createConcurrentRollbackWorkflow(
  id: string,
  effectDelayMs: number,
  failRender: boolean,
): WorkflowDefinition<{ done: boolean }> {
  return {
    id,
    version: "0.1.0",
    description: `${id} concurrent rollback fixture.`,
    routing: defineRouting({
      examples: [id],
      entities: [id],
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
        name: "delayed_mutation",
        stage: "afterPatch",
        description: "Mutates after a delay so rollback must wait for all concurrent workflow tasks.",
        when: ({ state }) => state.done === false,
        run: async () => {
          await delay(effectDelayMs);
          return { state: { done: true } };
        },
      },
    ],
    render: () => {
      if (failRender) {
        throw new Error(`${id} failed`);
      }

      return {
        text: `${id} done`,
      };
    },
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

function createRollbackWorkflow(config: {
  id?: string;
} = {}): WorkflowDefinition<RollbackState> {
  const id = config.id ?? "rollback_flow";

  return {
    id,
    version: "0.1.0",
    description: `${id} rollback fixture.`,
    routing: defineRouting({
      examples: ["rollback"],
      entities: ["rollback"],
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
        kind: "prefetch",
        name: "remember_message",
        stage: "beforePatch",
        progress: "Remembering message",
        description: "Records the current message so failed turns can prove prefetch rollback.",
        run: ({ state }) => ({ lastMessage: latestUserMessageText(state.messages) ?? "" }),
      },
      {
        kind: "effect",
        name: "load_selected",
        stage: "afterPatch",
        description: "Records selected state in context and shared cache so failed turns can prove runtime rollback.",
        dependsOn: ["selected"],
        when: ({ state }) => state.selected !== null,
        run: ({ state, context, session }) => {
          context.set("lastSelected", state.selected);
          session.sharedCache.set("lastSelected", state.selected);
          return {
            state: {
              runs: state.runs + 1,
            },
          };
        },
      },
    ],
    render: ({ state }) => {
      if (latestUserMessageText(state.messages)?.includes("fail")) {
        throw new Error("rollback render failed");
      }

      return {
        text: `selected=${state.selected}; runs=${state.runs}`,
      };
    },
  };
}

function latestUserMessageText(messages: readonly WorkflowMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return undefined;
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
      return "candidate=alpha competitors; status=ready";
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

function createLoopResearchLlm(loopDecisions: unknown[]): LlmClient & { structuredCalls: unknown[] } {
  const structuredCalls: unknown[] = [];
  let loopIndex = 0;
  return {
    structuredCalls,
    async text() {
      return "candidate=alpha competitors; status=ready";
    },
    async structured(request) {
      structuredCalls.push(request);
      if (request.name === "workflow_route") {
        return request.schema.parse(routeDecisionForRequest(request));
      }
      if (request.name === "loop_research_flow_patch") {
        return request.schema.parse({
          statePatch: {
            researchQuestions: ["research alpha"],
          },
        });
      }
      if (request.name === "loop_research_flow_research_loop_state") {
        const decision = loopDecisions[loopIndex];
        loopIndex += 1;
        return request.schema.parse(decision);
      }
      throw new Error(`Unexpected structured request: ${request.name}`);
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
}): LlmClient & { structuredCalls: unknown[]; streamCalls: string[]; streamRequests: LlmTextRequest[]; textCalls: unknown[] } {
  const structuredCalls: unknown[] = [];
  const streamCalls: string[] = [];
  const streamRequests: LlmTextRequest[] = [];
  const textCalls: unknown[] = [];

  return {
    structuredCalls,
    streamCalls,
    streamRequests,
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
      streamRequests.push(request);
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

function assistantText(message: LlmTextRequest["messages"][number] | undefined): string {
  if (!message || message.role !== "assistant") {
    throw new Error("Expected assistant message");
  }
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function structuredRequestNamed(
  calls: readonly unknown[],
  name: string,
): LlmStructuredRequest<z.ZodType> | undefined {
  return calls.find((call): call is LlmStructuredRequest<z.ZodType> =>
    Boolean(
      call &&
      typeof call === "object" &&
      (call as { name?: unknown }).name === name &&
      "instruction" in call &&
      "messages" in call,
    )
  );
}

async function collectStream(
  stream: AsyncIterable<EngineStreamPayload>,
): Promise<{ payloads: EngineStreamPayload[]; result: EngineInvokeResult }> {
  const payloads: EngineStreamPayload[] = [];
  const messages: EngineInvokeResult["messages"] = [];
  const events: EngineInvokeResult["events"] = [];
  let completed = false;
  for await (const payload of stream) {
    payloads.push(payload);
    if ("message" in payload) {
      messages.push(payload.message);
    } else {
      events.push(payload.event);
      if (payload.event.type === "engine.turn.done") {
        completed = true;
      }
    }
  }
  if (!completed) {
    throw new Error("Expected engine.turn.done stream event");
  }
  return { payloads, result: { messages, events } };
}

function primaryText(result: EngineInvokeResult): string {
  return result.messages.find((message) => message.role === "assistant")?.content ?? "";
}

function assistantTexts(result: EngineInvokeResult): string[] {
  return result.messages.flatMap((message) => message.role === "assistant" ? [message.content] : []);
}

function assistantWorkflowIds(result: EngineInvokeResult): string[] {
  return result.messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    const workflowId = message["workflowId"];
    return typeof workflowId === "string" ? [workflowId] : [];
  });
}

function traceEvents(result: EngineInvokeResult): EngineTraceEvent[] {
  return result.events.flatMap((event) => event.type === "engine.trace" ? [event.trace] : []);
}

function assistantDeltaSignatures(payloads: readonly EngineStreamPayload[]): string[] {
  return payloads.flatMap((payload) => {
    if (!("event" in payload) || payload.event.type !== "assistant.message.delta") return [];
    return [`${payload.event.workflowId}|${payload.event.workflowIds?.join("+") ?? ""}:${payload.event.delta}`];
  });
}

function assistantMessageContents(payloads: readonly EngineStreamPayload[]): string[] {
  return payloads.flatMap((payload) => {
    if (!("message" in payload) || payload.message.role !== "assistant") return [];
    return [payload.message.content];
  });
}

function workflowStepEventTypes(payloads: readonly EngineStreamPayload[]): string[] {
  return payloads.flatMap((payload) => {
    if (!("event" in payload) || !payload.event.type.startsWith("workflow.step.")) return [];
    return [payload.event.type];
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function eventually(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(5);
    }
  }

  if (lastError !== undefined) {
    throw lastError;
  }
  assertion();
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

function loopCallCount(llm: { structuredCalls: unknown[] }, name: string): number {
  return llm.structuredCalls.filter((call) => {
    return call && typeof call === "object" && (call as { name?: unknown }).name === name;
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

function isNestedTraceReason(detail: unknown, reason: string): boolean {
  if (!detail || typeof detail !== "object" || !("detail" in detail)) return false;
  return isTraceReason((detail as { detail?: unknown }).detail, reason);
}
