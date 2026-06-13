import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  type JsonRecord,
  type MessagePatch,
  PrefetchStore,
  type RenderPolicy,
  type RenderResponse,
  type WorkflowDefinition,
  type WorkflowMessage,
  WorkflowContextStore,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowNode,
  type WorkflowNodeStage,
  type WorkflowRuntimeState,
  type WorkflowTurn,
} from "@pac/workflow";
import { applyObjectPatch, applySessionPatch, cloneDefault, normalizeMessagePatch } from "./patching.js";
import { scoreWorkflow } from "./routing.js";
import { createEngineSession } from "./session.js";
import type {
  CreateSessionInput,
  EngineSession,
  EngineTraceEvent,
  EngineTurnResult,
  RuntimeInstance,
  RuntimeWorkflow,
  TargetSelection,
  WorkflowDefinitionInput,
  WorkflowEngineOptions,
} from "./types.js";

export class WorkflowEngine {
  private readonly registry = new Map<WorkflowId, RuntimeWorkflow>();
  private readonly deps: WorkflowEngineOptions["deps"];
  private readonly maxProgramRounds: number;
  private readonly logger?: WorkflowEngineOptions["logger"];
  private readonly onResponseDelta?: WorkflowEngineOptions["onResponseDelta"];

  constructor(options: WorkflowEngineOptions) {
    for (const candidate of options.workflows) {
      const workflow = toRuntimeWorkflow(candidate);
      this.registry.set(workflow.id, workflow);
    }

    this.deps = options.deps;
    this.maxProgramRounds = options.maxProgramRounds ?? 6;
    this.logger = options.logger;
    this.onResponseDelta = options.onResponseDelta;
  }

  createSession(input: CreateSessionInput): EngineSession {
    const session = createEngineSession(input);
    for (const workflowId of session.activeWorkflowIds) {
      this.ensureInstance(session, workflowId);
    }
    return session;
  }

  async onMessage(message: string, session: EngineSession): Promise<EngineTurnResult> {
    const traces: EngineTraceEvent[] = [];
    const turnChanges = new Map<WorkflowId, MutableTurnChanges>();
    const turnStartedAt = this.logStart("engine", "turn", { message });

    const targets = this.selectTargetWorkflows(message, session, traces);
    const preStates = new Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>(
      targets.instances.map((instance) => [instance.id, withRuntimeMessages(cloneDefault(instance.state))]),
    );
    for (const instance of targets.instances) {
      if (appendWorkflowMessage(instance.state, { role: "user", content: message })) {
        traces.push({
          workflowId: instance.id,
          phase: "messages.user",
          detail: { contentChars: message.length },
        });
        recordStateChanges(turnChangesFor(turnChanges, instance.id), ["messages"]);
      }
    }

    await Promise.all(
      targets.instances.map((instance) =>
        this.runNodeStageOnce(instance, session, message, traces, turnChanges, preStates, "beforePatch"),
      ),
    );

    await Promise.all(
      targets.instances.map((instance) =>
        this.runNodeStageOnce(instance, session, message, traces, turnChanges, preStates, "withPatch"),
      ),
    );
    const patches = await Promise.all(
      targets.instances.map((instance) => this.extractPatch(instance, traces)),
    );

    this.applyPatches(targets.instances, patches, session, traces, turnChanges);

    const runnable = this.instancesForActiveTargets(session, targets.ids);
    for (const instance of runnable) {
      await this.runNodeStageUntilStable(instance, session, message, traces, turnChanges, preStates, "afterPatch");
    }

    const responses = await this.renderResponses(runnable, session, message, traces, turnChanges, preStates);
    session.routingMemory.lastMatchedWorkflowIds = runnable.map((instance) => instance.id);

    this.logDone("engine", "turn", turnStartedAt, { responseTextChars: responses[0]?.response.text.length ?? 0 });

    return {
      response: responses[0]?.response ?? {
        text: "我还不能确定要执行哪个 workflow。",
      },
      responses,
      session,
      traces,
    };
  }

  getInstance<TState extends object>(
    session: EngineSession,
    workflowId: WorkflowId,
  ): WorkflowInstance<TState> | undefined {
    return session.workflowInstances.get(workflowId) as WorkflowInstance<TState> | undefined;
  }

  private selectTargetWorkflows(
    message: string,
    session: EngineSession,
    traces: EngineTraceEvent[],
  ): TargetSelection {
    if (session.activeWorkflowIds.length > 0) {
      const startedAt = this.logStart("engine", "routing.active");
      const instances = this.instancesForIds(session, session.activeWorkflowIds);
      traces.push({
        workflowId: instances[0]?.id ?? "none",
        phase: "routing.active",
        detail: instances.map((instance) => instance.id),
      });
      this.logDone("engine", "routing.active", startedAt, instances.map((instance) => instance.id));

      return {
        instances,
        ids: new Set(instances.map((instance) => instance.id)),
      };
    }

    const startedAt = this.logStart("engine", "routing.local");
    const best = this.findBestWorkflow(message);
    if (!best) {
      traces.push({ workflowId: "none", phase: "routing.none" });
      this.logDone("engine", "routing.local", startedAt, { matched: false });
      return { instances: [], ids: new Set() };
    }

    this.attachWorkflow(session, best.workflow.id);
    const instance = this.ensureInstance(session, best.workflow.id);
    const instances = instance ? [instance] : [];

    traces.push({
      workflowId: best.workflow.id,
      phase: "routing.local",
      detail: { score: best.score },
    });
    this.logDone("engine", "routing.local", startedAt, { workflowId: best.workflow.id, score: best.score });

    return {
      instances,
      ids: new Set(instances.map((item) => item.id)),
    };
  }

  private findBestWorkflow(message: string): { workflow: RuntimeWorkflow; score: number } | undefined {
    const [best] = [...this.registry.values()]
      .map((workflow) => ({
        workflow,
        score: scoreWorkflow(message, workflow),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    return best;
  }

  private async extractPatch(
    instance: RuntimeInstance,
    traces: EngineTraceEvent[],
  ): Promise<MessagePatch> {
    const name = `${instance.id}_patch`;
    if (instance.artifact.patch.progress) {
      this.emitProgress(traces, instance.id, {
        node: name,
        stage: "patch",
        progress: instance.artifact.patch.progress,
        description: "Extract structured workflow state from the latest user message.",
      });
    }
    const startedAt = this.logStart(instance.id, "llm.patch", { name, model: instance.artifact.patch.model ?? "default" });

    try {
      const now = (this.deps.now ?? (() => new Date()))().toISOString();
      const patch = await this.deps.llm.structured({
        name,
        model: instance.artifact.patch.model,
        instruction: patchInstructionForRuntime(instance.artifact.patch.instruction, now),
        schema: instance.artifact.patch.schema,
        messages: messagesForPatch(instance.state),
      });

      const normalized = normalizeMessagePatch(patch);
      this.logDone(instance.id, "llm.patch", startedAt, normalized);
      return normalized;
    } catch (error) {
      this.logDone(instance.id, "llm.patch", startedAt, { error: errorMessage(error) });
      throw error;
    }
  }

  private applyPatches(
    instances: RuntimeInstance[],
    patches: MessagePatch[],
    session: EngineSession,
    traces: EngineTraceEvent[],
    turnChanges: Map<WorkflowId, MutableTurnChanges>,
  ): void {
    for (const [index, instance] of instances.entries()) {
      const patch = patches[index] ?? {};
      const dirtyFields = this.applyMessagePatch(instance, session, patch, traces);
      const invalidated = this.applyInvalidation(instance, dirtyFields, traces);
      const changes = turnChangesFor(turnChanges, instance.id);
      recordStateChanges(changes, dirtyFields);
      recordInvalidatedState(changes, invalidated);
    }
  }

  private instancesForActiveTargets(session: EngineSession, targetIds: Set<WorkflowId>): RuntimeInstance[] {
    return this.instancesForIds(
      session,
      session.activeWorkflowIds.filter((id) => targetIds.has(id)),
    );
  }

  private instancesForIds(session: EngineSession, workflowIds: WorkflowId[]): RuntimeInstance[] {
    return workflowIds
      .map((id) => this.ensureInstance(session, id))
      .filter((instance): instance is RuntimeInstance => Boolean(instance));
  }

  private ensureInstance(session: EngineSession, workflowId: WorkflowId): RuntimeInstance | undefined {
    const existing = session.workflowInstances.get(workflowId);
    if (existing) return existing;

    const artifact = this.registry.get(workflowId);
    if (!artifact) return undefined;

    const instance: RuntimeInstance = {
      id: artifact.id,
      version: artifact.version,
      artifact,
      context: new WorkflowContextStore(this.deps.connectors),
      state: withRuntimeMessages(artifact.stateSchema.parse(cloneDefault(artifact.state))),
      prefetch: new PrefetchStore(),
    };

    session.workflowInstances.set(workflowId, instance);
    return instance;
  }

  private async runNodeStageOnce(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: Map<WorkflowId, MutableTurnChanges>,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    stage: WorkflowNodeStage,
  ): Promise<void> {
    await this.runNodeStageRound(instance, session, message, traces, turnChanges, preStates, stage);
  }

  private applyMessagePatch(
    instance: RuntimeInstance,
    session: EngineSession,
    patch: MessagePatch,
    traces: EngineTraceEvent[],
  ): string[] {
    applySessionPatch(session, patch.sessionPatch);
    const dirtyFields = applyObjectPatch(instance.state, patch.statePatch ?? {});

    traces.push({
      workflowId: instance.id,
      phase: "patch",
      detail: {
        sessionPatch: patch.sessionPatch,
        statePatch: patch.statePatch,
        dirtyFields,
      },
    });

    return dirtyFields;
  }

  private applyInvalidation(
    instance: RuntimeInstance,
    dirtyFields: string[],
    traces: EngineTraceEvent[],
  ): string[] {
    const invalidated: string[] = [];
    const invalidatedSet = new Set<string>();
    const state = instance.state;
    const defaults = instance.artifact.state;
    const invalidation = instance.artifact.invalidation as Record<string, string[] | undefined>;
    const dirtyFieldSet = new Set(dirtyFields);

    for (const field of dirtyFields) {
      for (const dependent of invalidation[field] ?? []) {
        if (dirtyFieldSet.has(dependent)) continue;
        if (invalidatedSet.has(dependent)) continue;
        state[dependent] = cloneDefault(defaults[dependent] ?? null);
        invalidatedSet.add(dependent);
        invalidated.push(dependent);
      }
    }

    if (invalidated.length > 0) {
      traces.push({
        workflowId: instance.id,
        phase: "invalidate",
        detail: invalidated,
      });
    }

    return invalidated;
  }

  private attachWorkflow(session: EngineSession, workflowId: WorkflowId): void {
    if (!this.registry.has(workflowId) || session.activeWorkflowIds.includes(workflowId)) return;
    session.activeWorkflowIds.push(workflowId);
    this.ensureInstance(session, workflowId);
  }

  private async runNodeStageUntilStable(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: Map<WorkflowId, MutableTurnChanges>,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    stage: WorkflowNodeStage,
  ): Promise<void> {
    for (let round = 0; round < this.maxProgramRounds; round += 1) {
      const phase = `nodes.${stage}.round`;
      const startedAt = this.logStart(instance.id, phase, { round });

      const changed = await this.runNodeStageRound(instance, session, message, traces, turnChanges, preStates, stage);
      this.logDone(instance.id, phase, startedAt, { round, changed });

      if (!changed) return;
    }

    traces.push({
      workflowId: instance.id,
      phase: `nodes.${stage}.maxRounds`,
      detail: { maxProgramRounds: this.maxProgramRounds },
    });
  }

  private async runNodeStageRound(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: Map<WorkflowId, MutableTurnChanges>,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    stage: WorkflowNodeStage,
  ): Promise<boolean> {
    let changed = false;

    for (const node of instance.artifact.nodes) {
      if (node.stage !== stage) continue;

      const phase = `node.${stage}.${node.name}`;
      const input = {
        session,
        context: instance.context,
        state: instance.state,
        preState: preStateFor(preStates, instance),
        prefetch: instance.prefetch,
        deps: this.deps,
        turn: turnSnapshot(turnChangesFor(turnChanges, instance.id)),
        message,
      };

      if (node.when && !(await node.when(input))) {
        traces.push({
          workflowId: instance.id,
          phase: `${phase}.skip`,
          detail: { reason: "when" },
        });
        this.logSkip(instance.id, phase, { reason: "when" });
        continue;
      }

      const progressDetail = {
        node: node.name,
        stage: node.stage,
        progress: node.progress,
        description: node.description,
      };
      this.emitProgress(traces, instance.id, progressDetail);

      const startedAt = this.logStart(instance.id, phase);

      const result = await this.runNode(instance, session, message, traces, turnChanges, preStates, node);

      if (result.changed) {
        changed = true;
      }

      this.logDone(instance.id, phase, startedAt, result.detail);
    }

    return changed;
  }

  private async runNode(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: Map<WorkflowId, MutableTurnChanges>,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    node: WorkflowNode<JsonRecord>,
  ): Promise<{ changed: boolean; detail: unknown }> {
    const changes = turnChangesFor(turnChanges, instance.id);
    const contextRevision = instance.context.revision;
    const input = {
      session,
      context: instance.context,
      state: instance.state,
      preState: preStateFor(preStates, instance),
      prefetch: instance.prefetch,
      deps: this.deps,
      turn: turnSnapshot(changes),
      message,
    };

    if (node.kind === "prefetch") {
      const result = await node.run(input);
      const appendedToolMessage = appendWorkflowMessage(instance.state, {
        role: "tool",
        name: node.name,
        call: { stage: node.stage },
        result: result ?? {},
      });
      const changedKeys = this.mergePrefetch(instance, result ?? undefined);
      const contextChangedKeys = instance.context.changedKeysSince(contextRevision);
      recordPrefetchChanges(changes, changedKeys);
      recordContextChanges(changes, contextChangedKeys);
      if (appendedToolMessage) {
        recordStateChanges(changes, ["messages"]);
      }
      const detail = {
        changed: changedKeys.length > 0 || contextChangedKeys.length > 0 || appendedToolMessage,
        changedKeys,
        contextChangedKeys,
        stateChangedFields: appendedToolMessage ? ["messages"] : [],
        prefetch: instance.prefetch.toJSON(),
      };

      if (changedKeys.length > 0 || contextChangedKeys.length > 0 || appendedToolMessage) {
        traces.push({
          workflowId: instance.id,
          phase: `node.${node.stage}.${node.name}`,
          detail,
        });
      }

      return { changed: changedKeys.length > 0 || contextChangedKeys.length > 0 || appendedToolMessage, detail };
    }

    const result = await node.run(input);
    const appendedMessages = appendWorkflowMessages(instance.state, result?.messages ?? []);
    const contextChangedKeys = instance.context.changedKeysSince(contextRevision);
    if (!result) {
      recordContextChanges(changes, contextChangedKeys);
      if (appendedMessages.length > 0) {
        recordStateChanges(changes, ["messages"]);
      }
      const changed = contextChangedKeys.length > 0 || appendedMessages.length > 0;
      const detail = { changed, contextChangedKeys, appendedMessages: appendedMessages.length };
      if (changed) {
        traces.push({
          workflowId: instance.id,
          phase: `node.${node.stage}.${node.name}`,
          detail,
        });
      }
      return {
        changed,
        detail,
      };
    }

    const stateChanged = applyObjectPatch(instance.state, result.state ?? {});
    const invalidated = this.applyInvalidation(instance, stateChanged, traces);
    recordContextChanges(changes, contextChangedKeys);
    recordStateChanges(changes, stateChanged);
    if (appendedMessages.length > 0) {
      recordStateChanges(changes, ["messages"]);
    }
    recordInvalidatedState(changes, invalidated);
    const changed =
      contextChangedKeys.length > 0 ||
      stateChanged.length > 0 ||
      invalidated.length > 0 ||
      appendedMessages.length > 0;
    const detail = {
      changed,
      contextChangedKeys,
      statePatch: result.state,
      appendedMessages: appendedMessages.length,
      dirtyFields: stateChanged,
      invalidated,
    };

    if (changed) {
      traces.push({
        workflowId: instance.id,
        phase: `node.${node.stage}.${node.name}`,
        detail,
      });
    }

    return { changed, detail };
  }

  private mergePrefetch(instance: RuntimeInstance, values: Record<string, unknown> | undefined): string[] {
    if (!values) return [];

    const changedKeys: string[] = [];
    const current = instance.prefetch.toJSON();

    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && !sameValue(current[key], value)) {
        instance.prefetch.set(key, value);
        changedKeys.push(key);
      }
    }

    return changedKeys;
  }

  private async renderResponses(
    instances: RuntimeInstance[],
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: Map<WorkflowId, MutableTurnChanges>,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
  ): Promise<Array<{ workflowId: WorkflowId; response: RenderResponse }>> {
    return Promise.all(
      instances.map(async (instance) => {
        const startedAt = this.logStart(instance.id, "render");
        const response = await this.renderInstance(instance, session, message, turnChanges, preStates, traces);
        this.logDone(instance.id, "render", startedAt, { textChars: response.text.length });
        if (appendWorkflowMessage(instance.state, { role: "assistant", content: response.text })) {
          traces.push({
            workflowId: instance.id,
            phase: "messages.assistant",
            detail: { contentChars: response.text.length },
          });
          recordStateChanges(turnChangesFor(turnChanges, instance.id), ["messages"]);
        }
        return {
          workflowId: instance.id,
          response,
        };
      }),
    );
  }

  private logStart(workflowId: WorkflowId | "engine", phase: string, detail?: unknown): number {
    this.logger?.(formatLogLine(workflowId, phase, "start", undefined, detail));
    return Date.now();
  }

  private logDone(workflowId: WorkflowId | "engine", phase: string, startedAt: number, detail?: unknown): void {
    this.logger?.(formatLogLine(workflowId, phase, "done", Date.now() - startedAt, detail));
  }

  private logSkip(workflowId: WorkflowId | "engine", phase: string, detail?: unknown): void {
    this.logger?.(formatLogLine(workflowId, phase, "skip", undefined, detail));
  }

  private logEvent(workflowId: WorkflowId | "engine", phase: string, detail?: unknown): void {
    this.logger?.(formatLogLine(workflowId, phase, "event", undefined, detail));
  }

  private async renderInstance(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    turnChanges: Map<WorkflowId, MutableTurnChanges>,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    traces: EngineTraceEvent[],
  ): Promise<RenderResponse> {
    const render = instance.artifact.render;
    if (typeof render === "function") {
      return render({
        session,
        context: instance.context,
        state: instance.state,
        preState: preStateFor(preStates, instance),
        prefetch: instance.prefetch,
        deps: this.deps,
        turn: turnSnapshot(turnChangesFor(turnChanges, instance.id)),
        message,
      });
    }

    this.emitProgress(traces, instance.id, {
      node: render.name,
      stage: "render",
      progress: render.progress,
      description: "Render the next assistant reply from the workflow message log.",
    });

    const request = {
      name: render.name,
      instruction: render.instruction,
      messages: messagesForRender(instance.state),
    };

    if (this.deps.llm.streamText) {
      let text = "";
      for await (const event of this.deps.llm.streamText(request)) {
        if (event.type === "text_delta") {
          text += event.delta;
          this.onResponseDelta?.({ workflowId: instance.id, delta: event.delta });
          continue;
        }

        text = event.text;
      }

      return { text: text.trim() };
    }

    const text = await this.deps.llm.text(request);

    return { text: text.trim() };
  }

  private emitProgress(
    traces: EngineTraceEvent[],
    workflowId: WorkflowId,
    detail: { node: string; stage: string; progress: string; description?: string },
  ): void {
    traces.push({
      workflowId,
      phase: "node.progress",
      detail,
    });
    this.logEvent(workflowId, "node.progress", detail);
  }

}

function appendWorkflowMessage(state: WorkflowRuntimeState<JsonRecord>, message: WorkflowMessage): boolean {
  state.messages = [...state.messages, message];
  return true;
}

function appendWorkflowMessages(
  state: WorkflowRuntimeState<JsonRecord>,
  messages: readonly WorkflowMessage[],
): WorkflowMessage[] {
  if (messages.length === 0) return [];
  state.messages = [...state.messages, ...messages];
  return [...messages];
}

function withRuntimeMessages(state: JsonRecord): WorkflowRuntimeState<JsonRecord> {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return {
    ...state,
    messages: messages.filter(isWorkflowMessage),
  };
}

function preStateFor(
  preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
  instance: RuntimeInstance,
): WorkflowRuntimeState<JsonRecord> {
  return preStates.get(instance.id) ?? withRuntimeMessages(cloneDefault(instance.state));
}

interface MutableTurnChanges {
  stateChangedFields: Set<string>;
  contextChangedKeys: Set<string>;
  prefetchChangedKeys: Set<string>;
  invalidatedStateFields: Set<string>;
}

function turnChangesFor(
  turnChanges: Map<WorkflowId, MutableTurnChanges>,
  workflowId: WorkflowId,
): MutableTurnChanges {
  const existing = turnChanges.get(workflowId);
  if (existing) return existing;

  const next = {
    stateChangedFields: new Set<string>(),
    contextChangedKeys: new Set<string>(),
    prefetchChangedKeys: new Set<string>(),
    invalidatedStateFields: new Set<string>(),
  };
  turnChanges.set(workflowId, next);
  return next;
}

function turnSnapshot(changes: MutableTurnChanges): WorkflowTurn {
  return {
    stateChangedFields: [...changes.stateChangedFields],
    contextChangedKeys: [...changes.contextChangedKeys],
    prefetchChangedKeys: [...changes.prefetchChangedKeys],
    invalidatedStateFields: [...changes.invalidatedStateFields],
  };
}

function recordStateChanges(changes: MutableTurnChanges, fields: string[]): void {
  for (const field of fields) {
    changes.stateChangedFields.add(field);
  }
}

function recordContextChanges(changes: MutableTurnChanges, fields: string[]): void {
  for (const field of fields) {
    changes.contextChangedKeys.add(field);
  }
}

function recordPrefetchChanges(changes: MutableTurnChanges, keys: string[]): void {
  for (const key of keys) {
    changes.prefetchChangedKeys.add(key);
  }
}

function recordInvalidatedState(changes: MutableTurnChanges, fields: string[]): void {
  for (const field of fields) {
    changes.invalidatedStateFields.add(field);
  }
}

function toRuntimeWorkflow(candidate: WorkflowDefinitionInput): RuntimeWorkflow {
  if (!isWorkflowShape(candidate)) {
    throw new Error("Invalid workflow definition: missing required runtime fields");
  }

  const workflow = candidate as WorkflowDefinition<JsonRecord, unknown>;
  const nodes = workflow.nodes as Array<WorkflowNode<JsonRecord>>;

  if (nodes.length === 0) {
    throw new Error(`Workflow ${workflow.id} must define at least one node`);
  }

  return {
    id: workflow.id,
    version: workflow.version,
    description: workflow.description,
    routing: workflow.routing,
    stateSchema: workflow.stateSchema,
    state: workflow.state,
    nodes,
    patch: workflow.patch,
    invalidation: workflow.invalidation,
    render: workflow.render,
  } as RuntimeWorkflow;
}

function isWorkflowShape(candidate: unknown): candidate is WorkflowDefinitionInput {
  if (!candidate || typeof candidate !== "object") return false;

  const workflow = candidate as Record<string, unknown>;
  const patch = workflow.patch;
  const hasNodes = Array.isArray(workflow.nodes);
  return (
    typeof workflow.id === "string" &&
    typeof workflow.version === "string" &&
    typeof workflow.description === "string" &&
    typeof workflow.routing === "object" &&
    hasParser(workflow.stateSchema) &&
    Boolean(patch) &&
    typeof patch === "object" &&
    hasParser((patch as Record<string, unknown>).schema) &&
    hasNodes &&
    (typeof workflow.render === "function" || isRenderPolicy(workflow.render))
  );
}

function isRenderPolicy(value: unknown): value is RenderPolicy {
  if (!value || typeof value !== "object") return false;
  const render = value as Partial<RenderPolicy>;
  return (
    typeof render.name === "string" &&
    typeof render.instruction === "string" &&
    typeof render.progress === "string"
  );
}

function hasParser(value: unknown): value is { parse: (input: unknown) => unknown } {
  return Boolean(value) && typeof value === "object" && typeof (value as { parse?: unknown }).parse === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchInstructionForRuntime(instruction: string, now: string): string {
  return `${instruction}

Runtime boundary:
- Current time is ${now}.
- Use the current time only to resolve relative dates and times from the message log.`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatLogLine(
  workflowId: WorkflowId | "engine",
  phase: string,
  status: "start" | "done" | "skip" | "event",
  durationMs?: number,
  detail?: unknown,
): string {
  const duration = durationMs === undefined ? "" : ` ${durationMs}ms`;
  const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail, mapForLog)}`;
  return `[engine] ${workflowId} ${phase} ${status}${duration}${suffix}`;
}

function mapForLog(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return value;
}

function messagesForRender(state: JsonRecord): Message[] {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages
    .map(toPiMessage)
    .filter((message): message is Message => Boolean(message));
}

function messagesForPatch(state: JsonRecord): Message[] {
  return messagesForRender(state);
}

function isWorkflowMessage(message: unknown): message is WorkflowMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as JsonRecord;
  if (record.role === "user" || record.role === "assistant") {
    return typeof record.content === "string";
  }
  if (record.role === "tool") {
    return typeof record.name === "string" && "result" in record;
  }
  return false;
}

function toPiMessage(message: unknown): Message | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as JsonRecord;
  if (record.role === "user" && typeof record.content === "string") {
    return userMessage(record.content);
  }
  if (record.role === "assistant" && typeof record.content === "string") {
    return fauxAssistantMessage(record.content);
  }
  if (record.role === "tool") {
    const name = typeof record.name === "string" ? record.name : "tool";
    return userMessage(
      `Tool ${name} result:\n${JSON.stringify({
        call: record.call,
        result: record.result,
      }, mapForLog, 2)}`,
    );
  }
  return undefined;
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}
