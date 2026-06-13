import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectorRegistry,
  definePatch,
  defineRouting,
  type WorkflowDefinition,
  z,
} from "@pac/workflow";
import { WorkflowEngine } from "./engine.js";
import type { LlmClient } from "./llm.js";
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

test("WorkflowEngine returns fallback response when local routing does not match", async () => {
  const llm: LlmClient = {
    async text() {
      throw new Error("text generation should not run without a matched workflow");
    },
    async structured() {
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
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    },
  });
  const session = engine.createSession({ sessionId: "session_2", userId: "user_2" });

  const result = await engine.onMessage("please route me", session);
  const instance = engine.getInstance<TestState>(session, "test_flow");

  assert.equal(result.response.text, "selected=picked; dependent=default-dependent; derived=picked:loaded:true");
  assert.deepEqual(session.activeWorkflowIds, ["test_flow"]);
  assert.deepEqual(session.facts, { source: "unit-test" });
  assert.deepEqual(session.goals, ["exercise engine"]);
  assert.equal(instance?.state.selected, "picked");
  assert.equal(instance?.state.dependent, "default-dependent");
  assert.equal(instance?.state.derived, "picked:loaded:true");
  assert.deepEqual(instance?.prefetch.toJSON(), { baseline: "loaded" });
  assert.equal(instance?.state.messages.at(0)?.role, "user");
  assert.deepEqual(instance?.state.messages.at(-1), {
    role: "assistant",
    content: result.response.text,
  });
  assert.equal(llm.structuredCalls.length, 1);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.local" && trace.workflowId === "test_flow"));
  assert.ok(result.traces.some((trace) => trace.phase === "invalidate"));
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
  const instance = engine.getInstance<OptionalInvalidationState>(session, "optional_invalidation_flow");

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
  const instance = engine.getInstance<SameTurnInvalidationState>(session, "same_turn_invalidation_flow");

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
  const instance = engine.getInstance<TestState>(session, "reserved_messages_patch_flow");

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
  const instance = engine.getInstance<TestState>(session, "stream_flow");

  assert.equal(result.response.text, "hello world");
  assert.deepEqual(deltas, ["stream_flow:hello", "stream_flow: ", "stream_flow:world"]);
  assert.deepEqual(instance?.state.messages.at(-1), {
    role: "assistant",
    content: "hello world",
  });
  assert.equal(llm.streamCalls.length, 1);
  assert.equal(llm.textCalls.length, 0);
});

test("WorkflowEngine validates LLM render text output", async () => {
  const llm: LlmClient = {
    async structured(request) {
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
  const instance = engine.getInstance<{ count: number }>(session, "round_flow");

  assert.equal(result.response.text, "count=2");
  assert.equal(instance?.state.count, 2);
  assert.ok(result.traces.some((trace) => trace.phase === "nodes.afterPatch.maxRounds"));
});

test("WorkflowEngine keeps routing to active workflows instead of rematching local keywords", async () => {
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
  const activeInstance = engine.getInstance<TestState>(session, "test_flow");
  const competingInstance = engine.getInstance<TestState>(session, "competing_flow");

  assert.deepEqual(result.responses.map((response) => response.workflowId), ["test_flow"]);
  assert.deepEqual(session.activeWorkflowIds, ["test_flow"]);
  assert.equal(activeInstance?.state.selected, "active");
  assert.equal(competingInstance, undefined);
  assert.ok(result.traces.some((trace) => trace.phase === "routing.active"));
  assert.equal(llm.structuredCalls.length, 1);
});

test("WorkflowEngine validates createSession input and active workflow ids", () => {
  const engine = new WorkflowEngine({
    workflows: [createTestWorkflow()],
    deps: {
      llm: createPatchLlm({ statePatch: {} }),
      connectors: createConnectorRegistry(),
    },
  });

  assert.throws(
    () => engine.createSession(null as never),
    /Invalid create session input: input must be an object/,
  );
  assert.throws(
    () => engine.createSession({ sessionId: "", userId: "user_1" }),
    /sessionId must be a non-empty string/,
  );
  assert.throws(
    () =>
      engine.createSession({
        sessionId: "session_bad_facts",
        userId: "user_1",
        facts: [] as never,
      }),
    /facts must be an object/,
  );
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

test("WorkflowEngine validates onMessage input and mutable session state", async () => {
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
  await assert.rejects(
    engine.onMessage("route me", null as never),
    /Invalid engine session: session must be an object/,
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

  const instanceSession = engine.createSession({
    sessionId: "session_bad_instance",
    userId: "user_1",
    activeWorkflowIds: ["test_flow"],
  });
  const instance = engine.getInstance<TestState>(instanceSession, "test_flow");
  assert.ok(instance);
  const runtimeInstance = instanceSession.workflowInstances.get("test_flow");
  assert.ok(runtimeInstance);

  instanceSession.workflowInstances.set("missing_flow", runtimeInstance);
  await assert.rejects(
    engine.onMessage("route me", instanceSession),
    /workflowInstances contains unknown workflow id: missing_flow/,
  );

  instanceSession.workflowInstances.delete("missing_flow");
  instanceSession.workflowInstances.set("test_flow", { ...runtimeInstance, id: "wrong_flow" });
  await assert.rejects(
    engine.onMessage("route me", instanceSession),
    /workflowInstances\[test_flow\] id mismatch: wrong_flow/,
  );

  instanceSession.workflowInstances.set("test_flow", {
    ...runtimeInstance,
    artifact: { ...runtimeInstance.artifact },
  });
  await assert.rejects(
    engine.onMessage("route me", instanceSession),
    /workflowInstances\[test_flow\] artifact must match the registered workflow/,
  );
});

test("WorkflowEngine rejects malformed workflow definitions during construction", () => {
  const workflow = createTestWorkflow();
  const validNode = workflow.nodes[0]!;

  assert.throws(
    () => createEngineWithWorkflow({ ...workflow, routing: null }),
    /routing must be an object/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        routing: {
          ...workflow.routing,
          thresholds: {
            ...workflow.routing.thresholds,
            localAccept: 1.5,
          },
        },
      }),
    /routing\.thresholds\.localAccept must be a finite number between 0 and 1/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        routing: {
          ...workflow.routing,
          thresholds: {
            ...workflow.routing.thresholds,
            localAcept: 0.9,
          },
        },
      }),
    /routing\.thresholds\.localAcept is not supported/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        patch: {
          ...workflow.patch,
          instruction: "",
        },
      }),
    /patch\.instruction must be a non-empty string/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        patch: {
          ...workflow.patch,
          model: " ",
        },
      }),
    /patch\.model must be a non-empty string/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        invalidation: {
          selected: [" "],
        },
      }),
    /invalidation\.selected must be an array of non-empty strings/,
  );
  assert.throws(
    () => createEngineWithWorkflow({ ...workflow, nodes: [{ ...validNode, stage: "later" }] }),
    /nodes\[0\] must be a valid workflow node/,
  );
  assert.throws(
    () =>
      createEngineWithWorkflow({
        ...workflow,
        nodes: [
          validNode,
          { ...validNode },
        ],
      }),
    /duplicate node name: prepare_dependent/,
  );
  assert.throws(
    () => createEngineWithWorkflow({
      ...workflow,
      render: { name: "render", instruction: "", progress: "Rendering" },
    }),
    /render must be a function or render policy/,
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

test("WorkflowEngine rejects malformed engine options during construction", () => {
  const workflow = createTestWorkflow();

  assert.throws(
    () => new WorkflowEngine(null as never),
    /Invalid workflow engine options: options must be an object/,
  );
  assert.throws(
    () =>
      new WorkflowEngine({
        workflows: [workflow],
        deps: {
          connectors: {},
          llm: createPatchLlm({ statePatch: {} }),
        },
      } as never),
    /deps\.connectors must provide call/,
  );
  assert.throws(
    () =>
      new WorkflowEngine({
        workflows: [workflow],
        deps: {
          connectors: createConnectorRegistry(),
          llm: { text: async () => "ok" },
        },
      } as never),
    /deps\.llm must provide text\(request\) and structured\(request\)/,
  );
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
