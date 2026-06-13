import {
  type JsonRecord,
  type MessagePatch,
  PrefetchStore,
  type RenderPolicy,
  type RenderResponse,
  type WorkflowDefinition,
  type WorkflowEffectNode,
  WorkflowContextStore,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowNode,
  type WorkflowNodeStage,
  type WorkflowPrefetchNode,
  type WorkflowRuntimeInput,
  type WorkflowRuntimeState,
} from "@pac/workflow";
import { applyObjectPatch, applySessionPatch, cloneDefault, normalizeMessagePatch } from "./patching.js";
import { sameRuntimeValue } from "./utils/json.js";
import { scoreWorkflow } from "./routing.js";
import { createEngineSession } from "./session.js";
import { formatLogLine } from "./utils/logging.js";
import {
  appendWorkflowMessage,
  appendWorkflowMessages,
  messagesForPatch,
  messagesForRender,
  withRuntimeMessages,
} from "./utils/messages.js";
import { normalizeRenderResponse, normalizeStreamTextEvent, renderText } from "./utils/rendering.js";
import { preStateFor, resetStateField } from "./utils/state.js";
import { TurnChangeTracker, type WorkflowTurnChanges } from "./utils/turn.js";
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

const RESERVED_STATE_FIELDS = new Set(["messages"]);
const ROUTING_THRESHOLD_FIELDS = ["localAccept", "localUncertain", "globalAccept"] as const;

export class WorkflowEngine {
  private readonly registry = new Map<WorkflowId, RuntimeWorkflow>();
  private readonly deps: WorkflowEngineOptions["deps"];
  private readonly maxProgramRounds: number;
  private readonly logger?: WorkflowEngineOptions["logger"];
  private readonly onResponseDelta?: WorkflowEngineOptions["onResponseDelta"];

  constructor(options: WorkflowEngineOptions) {
    const optionsError = validateEngineOptionsShape(options);
    if (optionsError) {
      throw new Error(`Invalid workflow engine options: ${optionsError}`);
    }

    for (const candidate of options.workflows) {
      const workflow = toRuntimeWorkflow(candidate);
      if (this.registry.has(workflow.id)) {
        throw new Error(`Duplicate workflow id: ${workflow.id}`);
      }

      this.registry.set(workflow.id, workflow);
    }

    this.deps = options.deps;
    this.maxProgramRounds = options.maxProgramRounds ?? 6;
    this.logger = options.logger;
    this.onResponseDelta = options.onResponseDelta;
  }

  createSession(input: CreateSessionInput): EngineSession {
    const inputError = validateCreateSessionInputShape(input);
    if (inputError) {
      throw new Error(`Invalid create session input: ${inputError}`);
    }

    const duplicateWorkflowId = firstDuplicate(input.activeWorkflowIds ?? []);
    if (duplicateWorkflowId) {
      throw new Error(`Duplicate active workflow id: ${duplicateWorkflowId}`);
    }

    const unknownWorkflowIds = (input.activeWorkflowIds ?? []).filter((workflowId) => !this.registry.has(workflowId));
    if (unknownWorkflowIds.length > 0) {
      throw new Error(`Unknown active workflow id(s): ${unknownWorkflowIds.join(", ")}`);
    }

    const session = createEngineSession(input);
    for (const workflowId of session.activeWorkflowIds) {
      this.ensureInstance(session, workflowId);
    }
    return session;
  }

  async onMessage(message: string, session: EngineSession): Promise<EngineTurnResult> {
    if (!isNonEmptyString(message)) {
      throw new Error("Invalid message: message must be a non-empty string");
    }
    const sessionError = this.validateEngineSessionShape(session);
    if (sessionError) {
      throw new Error(`Invalid engine session: ${sessionError}`);
    }

    const traces: EngineTraceEvent[] = [];
    const turnChanges = new TurnChangeTracker();
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
        turnChanges.forWorkflow(instance.id).recordState(["messages"]);
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

  private validateEngineSessionShape(candidate: unknown): string | undefined {
    const shapeError = validateEngineSessionShape(candidate);
    if (shapeError) return shapeError;

    const session = candidate as EngineSession;
    const activeWorkflowError = this.validateActiveWorkflowIds(session.activeWorkflowIds);
    if (activeWorkflowError) return activeWorkflowError;

    return this.validateWorkflowInstances(session.workflowInstances);
  }

  private validateActiveWorkflowIds(activeWorkflowIds: readonly string[]): string | undefined {
    const duplicateWorkflowId = firstDuplicate(activeWorkflowIds);
    if (duplicateWorkflowId) {
      return `duplicate active workflow id: ${duplicateWorkflowId}`;
    }

    const unknownWorkflowIds = activeWorkflowIds.filter((workflowId) => !this.registry.has(workflowId));
    if (unknownWorkflowIds.length > 0) {
      return `unknown active workflow id(s): ${unknownWorkflowIds.join(", ")}`;
    }

    return undefined;
  }

  private validateWorkflowInstances(instances: Map<WorkflowId, RuntimeInstance>): string | undefined {
    for (const [workflowId, instance] of instances) {
      if (!isNonEmptyString(workflowId)) return "workflowInstances keys must be non-empty strings";

      const workflow = this.registry.get(workflowId);
      if (!workflow) {
        return `workflowInstances contains unknown workflow id: ${workflowId}`;
      }

      const instanceError = validateRuntimeInstanceShape(instance);
      if (instanceError) {
        return `workflowInstances[${workflowId}] ${instanceError}`;
      }

      if (instance.id !== workflowId) {
        return `workflowInstances[${workflowId}] id mismatch: ${instance.id}`;
      }

      if (instance.version !== workflow.version) {
        return `workflowInstances[${workflowId}] version mismatch: ${instance.version} !== ${workflow.version}`;
      }

      if (instance.artifact !== workflow) {
        return `workflowInstances[${workflowId}] artifact must match the registered workflow`;
      }
    }

    return undefined;
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
        ...(instance.artifact.patch.model ? { model: instance.artifact.patch.model } : {}),
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
    turnChanges: TurnChangeTracker,
  ): void {
    for (const [index, instance] of instances.entries()) {
      const patch = patches[index] ?? {};
      const dirtyFields = this.applyMessagePatch(instance, session, patch, traces);
      const changes = turnChanges.forWorkflow(instance.id);
      changes.recordMessagePatchState(Object.keys(patch.statePatch ?? {}));
      const invalidated = this.applyInvalidation(instance, dirtyFields, traces);
      changes.recordState(dirtyFields);
      changes.recordInvalidatedState(invalidated);
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
    turnChanges: TurnChangeTracker,
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
    protectedFields: Iterable<string> = [],
  ): string[] {
    const invalidated: string[] = [];
    const invalidatedSet = new Set<string>();
    const state = instance.state;
    const defaults = instance.artifact.state;
    const invalidation = instance.artifact.invalidation as Record<string, string[] | undefined>;
    const dirtyFieldSet = new Set(dirtyFields);
    const protectedFieldSet = new Set(protectedFields);

    for (const field of dirtyFields) {
      for (const dependent of invalidation[field] ?? []) {
        if (dirtyFieldSet.has(dependent)) continue;
        if (protectedFieldSet.has(dependent)) continue;
        if (invalidatedSet.has(dependent)) continue;
        resetStateField(state, defaults, dependent);
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
    turnChanges: TurnChangeTracker,
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
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    stage: WorkflowNodeStage,
  ): Promise<boolean> {
    let changed = false;

    for (const node of instance.artifact.nodes) {
      if (node.stage !== stage) continue;

      const phase = `node.${stage}.${node.name}`;
      const input = this.nodeInput(instance, session, message, turnChanges, preStates);

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
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    node: WorkflowNode<JsonRecord>,
  ): Promise<NodeRunResult> {
    const changes = turnChanges.forWorkflow(instance.id);
    const contextRevision = instance.context.revision;
    const input = this.nodeInput(instance, session, message, turnChanges, preStates);

    if (node.kind === "prefetch") {
      return this.runPrefetchNode(instance, node, input, changes, contextRevision, traces);
    }

    return this.runEffectNode(instance, node, input, changes, contextRevision, traces);
  }

  /**
   * Builds the runtime input visible to workflow predicates and node callbacks.
   * Input: current engine/session state plus turn-change tracking.
   * Output: a snapshot object passed to workflow-owned code.
   * Boundary: callers choose when to build the snapshot so turn data reflects the intended execution point.
   */
  private nodeInput(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
  ): WorkflowRuntimeInput<JsonRecord> {
    const changes = turnChanges.forWorkflow(instance.id);
    return {
      session,
      context: instance.context,
      state: instance.state,
      preState: preStateFor(preStates, instance),
      prefetch: instance.prefetch,
      deps: this.deps,
      turn: changes.snapshot(),
      message,
    };
  }

  /**
   * Runs a prefetch node and applies only read-through cache and tool-message side effects.
   * Input: runtime node input, turn-change tracking, and the context revision before node execution.
   * Output: node-change detail used for stabilization and tracing.
   * Boundary: prefetch nodes cannot patch workflow state directly; they expose fetched values through prefetch/context.
   */
  private async runPrefetchNode(
    instance: RuntimeInstance,
    node: WorkflowPrefetchNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    changes: WorkflowTurnChanges,
    contextRevision: number,
    traces: EngineTraceEvent[],
  ): Promise<NodeRunResult> {
    const result = await node.run(input);
    const changedKeys = this.mergePrefetch(instance, result === undefined ? undefined : result);
    const appendedToolMessage = appendWorkflowMessage(instance.state, {
      role: "tool",
      name: node.name,
      call: { stage: node.stage },
      result: result ?? {},
    });
    const contextChangedKeys = instance.context.changedKeysSince(contextRevision);

    changes.recordPrefetch(changedKeys);
    changes.recordContext(contextChangedKeys);
    if (appendedToolMessage) {
      changes.recordState(["messages"]);
    }

    const detail = {
      changed: changedKeys.length > 0 || contextChangedKeys.length > 0 || appendedToolMessage,
      changedKeys,
      contextChangedKeys,
      stateChangedFields: appendedToolMessage ? ["messages"] : [],
      prefetch: instance.prefetch.toJSON(),
    };
    this.recordNodeTraceIfChanged(instance, node, detail, traces);

    return { changed: detail.changed, detail };
  }

  /**
   * Runs an effect node and applies workflow state, message, context, and invalidation changes.
   * Input: runtime node input, turn-change tracking, and the context revision before node execution.
   * Output: node-change detail used for stabilization and tracing.
   * Boundary: irreversible external side effects happen inside node.run; this method only applies returned patches.
   */
  private async runEffectNode(
    instance: RuntimeInstance,
    node: WorkflowEffectNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    changes: WorkflowTurnChanges,
    contextRevision: number,
    traces: EngineTraceEvent[],
  ): Promise<NodeRunResult> {
    const result = await node.run(input);
    const appendedMessages = appendWorkflowMessages(instance.state, result?.messages ?? []);
    const contextChangedKeys = instance.context.changedKeysSince(contextRevision);
    if (!result) {
      changes.recordContext(contextChangedKeys);
      if (appendedMessages.length > 0) {
        changes.recordState(["messages"]);
      }
      const changed = contextChangedKeys.length > 0 || appendedMessages.length > 0;
      const detail = { changed, contextChangedKeys, appendedMessages: appendedMessages.length };
      this.recordNodeTraceIfChanged(instance, node, detail, traces);
      return {
        changed,
        detail,
      };
    }

    const stateChanged = applyObjectPatch(instance.state, result.state ?? {});
    const invalidated = this.applyInvalidation(
      instance,
      stateChanged,
      traces,
      changes.messagePatchedStateFields,
    );
    changes.recordContext(contextChangedKeys);
    changes.recordState(stateChanged);
    if (appendedMessages.length > 0) {
      changes.recordState(["messages"]);
    }
    changes.recordInvalidatedState(invalidated);
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
    this.recordNodeTraceIfChanged(instance, node, detail, traces);

    return { changed, detail };
  }

  private recordNodeTraceIfChanged(
    instance: RuntimeInstance,
    node: WorkflowNode<JsonRecord>,
    detail: NodeRunDetail,
    traces: EngineTraceEvent[],
  ): void {
    if (detail.changed) {
      traces.push({
        workflowId: instance.id,
        phase: `node.${node.stage}.${node.name}`,
        detail,
      });
    }
  }

  private mergePrefetch(instance: RuntimeInstance, values: unknown): string[] {
    if (!values) return [];
    if (!isPlainObject(values)) {
      throw new Error(`Workflow ${instance.id} prefetch result must be a plain object`);
    }
    for (const key of Object.keys(values)) {
      if (!isNonEmptyString(key)) {
        throw new Error(`Workflow ${instance.id} prefetch key must be a non-empty string`);
      }
    }

    const changedKeys: string[] = [];
    const current = instance.prefetch.toJSON();

    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && !sameRuntimeValue(current[key], value)) {
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
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
  ): Promise<Array<{ workflowId: WorkflowId; response: RenderResponse }>> {
    if (this.onResponseDelta) {
      const responses: Array<{ workflowId: WorkflowId; response: RenderResponse }> = [];
      for (const instance of instances) {
        responses.push(await this.renderAndRecordResponse(instance, session, message, traces, turnChanges, preStates));
      }
      return responses;
    }

    return Promise.all(
      instances.map(async (instance) => {
        return this.renderAndRecordResponse(instance, session, message, traces, turnChanges, preStates);
      }),
    );
  }

  /**
   * Renders one workflow response and records the assistant message in that workflow's runtime state.
   * Input: one runtime workflow instance plus the current session, message, traces, and turn-change stores.
   * Output: the workflow id paired with its rendered response.
   * Boundary: the caller decides whether multiple workflows render concurrently or sequentially.
   */
  private async renderAndRecordResponse(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
  ): Promise<{ workflowId: WorkflowId; response: RenderResponse }> {
    const startedAt = this.logStart(instance.id, "render");
    const response = await this.renderInstance(instance, session, message, turnChanges, preStates, traces);
    this.logDone(instance.id, "render", startedAt, { textChars: response.text.length });
    if (appendWorkflowMessage(instance.state, { role: "assistant", content: response.text })) {
      traces.push({
        workflowId: instance.id,
        phase: "messages.assistant",
        detail: { contentChars: response.text.length },
      });
      turnChanges.forWorkflow(instance.id).recordState(["messages"]);
    }
    return {
      workflowId: instance.id,
      response,
    };
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
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    traces: EngineTraceEvent[],
  ): Promise<RenderResponse> {
    const render = instance.artifact.render;
    if (typeof render === "function") {
      const response = await render({
        session,
        context: instance.context,
        state: instance.state,
        preState: preStateFor(preStates, instance),
        prefetch: instance.prefetch,
        deps: this.deps,
        turn: turnChanges.snapshot(instance.id),
        message,
      });
      return normalizeRenderResponse(instance.id, response);
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
        const normalizedEvent = normalizeStreamTextEvent(instance.id, event);
        if (normalizedEvent.type === "text_delta") {
          text += normalizedEvent.delta;
          this.onResponseDelta?.({ workflowId: instance.id, delta: normalizedEvent.delta });
          continue;
        }

        text = normalizedEvent.text;
      }

      return { text: text.trim() };
    }

    const text = renderText(instance.id, await this.deps.llm.text(request), "llm.text");

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

type NodeRunDetail = JsonRecord & {
  changed: boolean;
};

interface NodeRunResult {
  changed: boolean;
  detail: NodeRunDetail;
}

function validateEngineOptionsShape(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return "options must be an object";
  if (!Array.isArray(candidate.workflows)) return "workflows must be an array";
  if (!isRecord(candidate.deps)) return "deps must be an object";
  if (!hasConnectorRegistryShape(candidate.deps.connectors)) return "deps.connectors must provide call(id, input)";
  if (!hasLlmClientShape(candidate.deps.llm)) return "deps.llm must provide text(request) and structured(request)";
  if (candidate.deps.now !== undefined && typeof candidate.deps.now !== "function") return "deps.now must be a function";
  if (candidate.maxProgramRounds !== undefined && !isPositiveInteger(candidate.maxProgramRounds)) {
    return "maxProgramRounds must be a positive integer";
  }
  if (candidate.logger !== undefined && typeof candidate.logger !== "function") return "logger must be a function";
  if (candidate.onResponseDelta !== undefined && typeof candidate.onResponseDelta !== "function") {
    return "onResponseDelta must be a function";
  }

  return undefined;
}

function hasConnectorRegistryShape(value: unknown): boolean {
  return isRecord(value) && typeof value.call === "function";
}

function hasLlmClientShape(value: unknown): boolean {
  return isRecord(value) && typeof value.text === "function" && typeof value.structured === "function";
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateCreateSessionInputShape(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return "input must be an object";
  if (!isNonEmptyString(candidate.sessionId)) return "sessionId must be a non-empty string";
  if (!isNonEmptyString(candidate.userId)) return "userId must be a non-empty string";
  if (candidate.activeWorkflowIds !== undefined && !isNonEmptyStringArray(candidate.activeWorkflowIds)) {
    return "activeWorkflowIds must be an array of non-empty strings";
  }
  if (candidate.facts !== undefined && !isPlainObject(candidate.facts)) return "facts must be an object";
  if (candidate.preferences !== undefined && !isPlainObject(candidate.preferences)) return "preferences must be an object";
  if (candidate.goals !== undefined && !isStringArray(candidate.goals)) return "goals must be an array of strings";
  if (candidate.constraints !== undefined && !isStringArray(candidate.constraints)) {
    return "constraints must be an array of strings";
  }

  return undefined;
}

function validateEngineSessionShape(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return "session must be an object";
  if (!isNonEmptyString(candidate.sessionId)) return "sessionId must be a non-empty string";
  if (!isNonEmptyString(candidate.userId)) return "userId must be a non-empty string";
  if (!isNonEmptyStringArray(candidate.activeWorkflowIds)) return "activeWorkflowIds must be an array of non-empty strings";
  if (!isPlainObject(candidate.facts)) return "facts must be an object";
  if (!isPlainObject(candidate.preferences)) return "preferences must be an object";
  if (!isStringArray(candidate.goals)) return "goals must be an array of strings";
  if (!isStringArray(candidate.constraints)) return "constraints must be an array of strings";
  if (!(candidate.sharedCache instanceof Map)) return "sharedCache must be a Map";
  if (!hasRoutingMemoryShape(candidate.routingMemory)) {
    return "routingMemory.lastMatchedWorkflowIds must be an array of strings";
  }
  if (!(candidate.workflowInstances instanceof Map)) return "workflowInstances must be a Map";
  if (candidate.conversationSummary !== undefined && typeof candidate.conversationSummary !== "string") {
    return "conversationSummary must be a string";
  }

  return undefined;
}

function validateRuntimeInstanceShape(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return "must be an object";
  if (!isNonEmptyString(candidate.id)) return "id must be a non-empty string";
  if (!isNonEmptyString(candidate.version)) return "version must be a non-empty string";
  if (!isRecord(candidate.artifact)) return "artifact must be an object";
  if (!hasWorkflowContextShape(candidate.context)) return "context must provide workflow context methods";
  if (!isRecord(candidate.state)) return "state must be an object";
  if (!hasPrefetchStoreShape(candidate.prefetch)) return "prefetch must provide get, set, and toJSON methods";

  return undefined;
}

function hasWorkflowContextShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.revision === "number" &&
    typeof value.get === "function" &&
    typeof value.set === "function" &&
    typeof value.call === "function" &&
    typeof value.changedKeysSince === "function" &&
    typeof value.toJSON === "function"
  );
}

function hasPrefetchStoreShape(value: unknown): boolean {
  return isRecord(value) && typeof value.get === "function" && typeof value.set === "function" && typeof value.toJSON === "function";
}

function hasRoutingMemoryShape(value: unknown): value is EngineSession["routingMemory"] {
  return isRecord(value) && isStringArray(value.lastMatchedWorkflowIds);
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }

  return undefined;
}

function toRuntimeWorkflow(candidate: WorkflowDefinitionInput): RuntimeWorkflow {
  const validationError = validateWorkflowShape(candidate);
  if (validationError) {
    throw new Error(`Invalid workflow definition: ${validationError}`);
  }

  const workflow = candidate as WorkflowDefinition<JsonRecord, unknown>;
  const nodes = workflow.nodes as Array<WorkflowNode<JsonRecord>>;
  const state = parseWorkflowDefaultState(workflow.id, workflow.stateSchema, workflow.state);

  if (nodes.length === 0) {
    throw new Error(`Workflow ${workflow.id} must define at least one node`);
  }

  return {
    id: workflow.id,
    version: workflow.version,
    description: workflow.description,
    routing: workflow.routing,
    stateSchema: workflow.stateSchema,
    state,
    nodes,
    patch: workflow.patch,
    invalidation: workflow.invalidation,
    render: workflow.render,
  } as RuntimeWorkflow;
}

function parseWorkflowDefaultState(
  workflowId: WorkflowId,
  stateSchema: { parse: (input: unknown) => unknown },
  state: unknown,
): JsonRecord {
  assertNoReservedStateFields(workflowId, "default state", state);

  let cloned: unknown;
  try {
    cloned = cloneDefault(state);
  } catch (error) {
    throw new Error(`Workflow ${workflowId} default state is not cloneable: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = stateSchema.parse(cloned);
  } catch (error) {
    throw new Error(`Workflow ${workflowId} default state does not satisfy stateSchema: ${errorMessage(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Workflow ${workflowId} default state must parse to an object`);
  }
  assertNoReservedStateFields(workflowId, "parsed default state", parsed);

  return parsed;
}

function assertNoReservedStateFields(workflowId: WorkflowId, label: string, state: unknown): void {
  if (!isRecord(state)) return;
  for (const field of RESERVED_STATE_FIELDS) {
    if (Object.hasOwn(state, field)) {
      throw new Error(`Workflow ${workflowId} ${label} must not define reserved ${field} field`);
    }
  }
}

function validateWorkflowShape(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return "workflow must be an object";

  const workflow = candidate;
  const patch = workflow.patch;

  if (!isNonEmptyString(workflow.id)) return "id must be a non-empty string";
  if (!isNonEmptyString(workflow.version)) return "version must be a non-empty string";
  if (!isNonEmptyString(workflow.description)) return "description must be a non-empty string";
  const routingError = validateRoutingProfile(workflow.routing);
  if (routingError) return routingError;
  if (!hasParser(workflow.stateSchema)) return "stateSchema must provide parse(input)";
  const patchError = validatePatchPolicy(patch);
  if (patchError) return patchError;
  const invalidationError = validateInvalidation(workflow.invalidation);
  if (invalidationError) return invalidationError;
  if (!Array.isArray(workflow.nodes)) return "nodes must be an array";

  const invalidNodeIndex = workflow.nodes.findIndex((node) => !isWorkflowNodeShape(node));
  if (invalidNodeIndex >= 0) return `nodes[${invalidNodeIndex}] must be a valid workflow node`;
  const duplicateNodeName = firstDuplicate(workflow.nodes.map((node) => node.name));
  if (duplicateNodeName) return `duplicate node name: ${duplicateNodeName}`;

  if (typeof workflow.render !== "function" && !isRenderPolicy(workflow.render)) {
    return "render must be a function or render policy";
  }

  return undefined;
}

function isWorkflowNodeShape(value: unknown): value is WorkflowNode<JsonRecord> {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "prefetch" || value.kind === "effect") &&
    isNonEmptyString(value.name) &&
    isWorkflowNodeStage(value.stage) &&
    isNonEmptyString(value.progress) &&
    isNonEmptyString(value.description) &&
    typeof value.run === "function" &&
    (value.when === undefined || typeof value.when === "function")
  );
}

function isWorkflowNodeStage(value: unknown): boolean {
  return value === "beforePatch" || value === "withPatch" || value === "afterPatch";
}

function validateRoutingProfile(value: unknown): string | undefined {
  if (!isRecord(value)) return "routing must be an object";
  if (!isNonEmptyStringArray(value.examples)) return "routing.examples must be an array of non-empty strings";
  if (!isNonEmptyStringArray(value.entities)) return "routing.entities must be an array of non-empty strings";
  if (!isNonEmptyStringArray(value.neighbors)) return "routing.neighbors must be an array of non-empty strings";
  if (!isPlainObject(value.thresholds)) return "routing.thresholds must be an object";

  const supportedThresholds = new Set<string>(ROUTING_THRESHOLD_FIELDS);
  for (const key of Object.keys(value.thresholds)) {
    if (!supportedThresholds.has(key)) {
      return `routing.thresholds.${key} is not supported`;
    }
  }

  for (const field of ROUTING_THRESHOLD_FIELDS) {
    if (!isRoutingThreshold(value.thresholds[field])) {
      return `routing.thresholds.${field} must be a finite number between 0 and 1`;
    }
  }

  return undefined;
}

function isRoutingThreshold(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validatePatchPolicy(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "patch must be an object";
  if (!hasParser(value.schema)) return "patch.schema must provide parse(input)";
  if (!isNonEmptyString(value.instruction)) return "patch.instruction must be a non-empty string";
  const modelError = validateOptionalNonEmptyString(value.model, "patch.model");
  if (modelError) return modelError;
  return validateOptionalNonEmptyString(value.progress, "patch.progress");
}

function validateInvalidation(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "invalidation must be an object";
  for (const [field, dependents] of Object.entries(value)) {
    if (!isNonEmptyString(field)) return "invalidation field must be a non-empty string";
    if (!Array.isArray(dependents) || dependents.length === 0 || !dependents.every(isNonEmptyString)) {
      return `invalidation.${field} must be an array of non-empty strings`;
    }
  }

  return undefined;
}

function validateOptionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return isNonEmptyString(value) ? undefined : `${label} must be a non-empty string`;
}

function isRenderPolicy(value: unknown): value is RenderPolicy {
  if (!isRecord(value)) return false;
  const render = value;
  return (
    isNonEmptyString(render.name) &&
    isNonEmptyString(render.instruction) &&
    isNonEmptyString(render.progress)
  );
}

function hasParser(value: unknown): value is { parse: (input: unknown) => unknown } {
  return isRecord(value) && typeof value.parse === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPlainObject(value: unknown): value is JsonRecord {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
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
