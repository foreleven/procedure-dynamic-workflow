/**
 * Workflow node execution semantics.
 *
 * This file owns when prefetch/effect nodes run, how returned patches and tool
 * messages are applied, how dependency-gated effects remember prior inputs, and
 * how workflow step events are traced. It does not select workflows, extract LLM
 * patches, render assistant text, or commit engine-level session messages.
 */
import {
  type JsonRecord,
  type WorkflowEffectNode,
  type WorkflowInstance,
  type WorkflowLoopEffectNode,
  type WorkflowLoopNode,
  type WorkflowLoopRuntime,
  type WorkflowNode,
  type WorkflowNodeStage,
  type WorkflowPrefetchNode,
  type WorkflowPatch,
  type WorkflowRuntimeInput,
  type WorkflowStepController,
  type WorkflowToolMessage,
} from "@pac/workflow";
import { z } from "zod";
import { applyObjectPatch } from "../patching.js";
import { applyWorkflowInvalidation } from "./mutations.js";
import type { EngineEventSink, EngineSession, WorkflowEngineOptions } from "../types.js";
import { RuntimeTracer } from "./tracer.js";
import { errorMessage } from "../utils/errors.js";
import { safeJsonStringify, sameRuntimeValue } from "../utils/json.js";
import { appendWorkflowMessage, appendWorkflowMessages, messagesForWorkflowMessages } from "../utils/messages.js";
import { TurnChangeTracker, type WorkflowTurnChanges } from "../utils/turn.js";

export interface WorkflowNodeRunnerCheckpoint {
  readonly effectDependencies: ReadonlyMap<
    WorkflowInstance<JsonRecord>,
    Map<string, readonly unknown[]> | undefined
  >;
  readonly loopCompletions: ReadonlyMap<
    WorkflowInstance<JsonRecord>,
    Map<string, LoopCompletion> | undefined
  >;
}

/**
 * Runs workflow nodes for a turn and records their runtime side effects.
 * Input: engine dependencies, runtime tracer, and the configured stabilization round limit.
 * Output: trace entries plus state/context/prefetch mutations on runtime instances.
 * Boundary: WorkflowEngine owns turn ordering; this runner owns node execution semantics.
 */
export class WorkflowNodeRunner {
  private readonly effectDependencies = new WeakMap<WorkflowInstance<JsonRecord>, Map<string, readonly unknown[]>>();
  private readonly loopCompletions = new WeakMap<WorkflowInstance<JsonRecord>, Map<string, LoopCompletion>>();

  constructor(
    private readonly deps: WorkflowEngineOptions["deps"],
    private readonly tracer: RuntimeTracer,
    private readonly maxProgramRounds: number,
  ) {}

  /**
   * Captures dependency-gated effect memory before a turn mutates it.
   * Input: workflow instances known at the transaction boundary.
   * Output: shallow dependency snapshots keyed by the live instance objects.
   * Boundary: dependency values follow the same by-reference semantics as normal effect gating.
   */
  checkpoint(
    instances: readonly WorkflowInstance<JsonRecord>[],
  ): WorkflowNodeRunnerCheckpoint {
    const effectDependencies = new Map<
      WorkflowInstance<JsonRecord>,
      Map<string, readonly unknown[]> | undefined
    >();
    const loopCompletions = new Map<
      WorkflowInstance<JsonRecord>,
      Map<string, LoopCompletion> | undefined
    >();

    for (const instance of instances) {
      const dependencies = this.effectDependencies.get(instance);
      effectDependencies.set(
        instance,
        dependencies === undefined ? undefined : cloneEffectDependencies(dependencies),
      );
      const completions = this.loopCompletions.get(instance);
      loopCompletions.set(
        instance,
        completions === undefined ? undefined : cloneLoopCompletions(completions),
      );
    }

    return { effectDependencies, loopCompletions };
  }

  /**
   * Restores dependency-gated effect memory after a failed turn.
   * Input: checkpoint from `checkpoint(...)`.
   * Output: dependency stores reset for the checkpointed live instances.
   * Boundary: instances created after the checkpoint are detached by WorkflowInstanceStore rollback.
   */
  restore(checkpoint: WorkflowNodeRunnerCheckpoint): void {
    for (const [instance, dependencies] of checkpoint.effectDependencies) {
      if (dependencies === undefined) {
        this.effectDependencies.delete(instance);
      } else {
        this.effectDependencies.set(instance, cloneEffectDependencies(dependencies));
      }
    }
    for (const [instance, completions] of checkpoint.loopCompletions) {
      if (completions === undefined) {
        this.loopCompletions.delete(instance);
      } else {
        this.loopCompletions.set(instance, cloneLoopCompletions(completions));
      }
    }
  }

  /**
   * Runs one node stage exactly once.
   * Input: a runtime instance, current session, event sink, turn changes, and stage.
   * Output: node side effects applied to the runtime instance.
   * Boundary: used for beforePatch and withPatch stages where stabilization is not desired.
   */
  async runStageOnce(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    stage: WorkflowNodeStage,
  ): Promise<void> {
    await this.runStageRound(instance, session, events, turnChanges, stage);
  }

  /**
   * Runs one node stage until no node reports a semantic change or the round limit is reached.
   * Input: a runtime instance, current session, event sink, turn changes, and stage.
   * Output: node side effects applied across stabilization rounds.
   * Boundary: max-round exhaustion is traced instead of throwing so callers can still render diagnostics.
   */
  async runStageUntilStable(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    stage: WorkflowNodeStage,
  ): Promise<void> {
    for (let round = 0; round < this.maxProgramRounds; round += 1) {
      const phase = `nodes.${stage}.round`;
      const startedAt = this.tracer.start(instance.id, phase, { round });

      const changed = await this.runStageRound(instance, session, events, turnChanges, stage);
      this.tracer.done(instance.id, phase, startedAt, { round, changed });

      if (!changed) return;
    }

    this.tracer.trace({
      workflowId: instance.id,
      phase: `nodes.${stage}.maxRounds`,
      detail: { maxProgramRounds: this.maxProgramRounds },
    }, events);
  }

  private async runStageRound(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    stage: WorkflowNodeStage,
  ): Promise<boolean> {
    let changed = false;

    for (const node of instance.artifact.nodes) {
      if (node.stage !== stage) continue;

      const phase = `node.${stage}.${node.name}`;
      const input = this.nodeInput(instance, session, turnChanges, noopStepController);

      if (node.when && !(await node.when(input))) {
        this.clearEffectDependenciesIfChanged(instance, node);
        this.tracer.trace({
          workflowId: instance.id,
          phase: `${phase}.skip`,
          detail: { reason: "when" },
        }, events);
        this.tracer.skip(instance.id, phase, { reason: "when" });
        continue;
      }

      const dependencyState = this.effectDependencyState(instance, node);
      if (!dependencyState.shouldRun) {
        const dependsOn = dependencyNodeDependsOn(node);
        this.tracer.trace({
          workflowId: instance.id,
          phase: `${phase}.skip`,
          detail: { reason: "dependencies", dependsOn },
        }, events);
        this.tracer.skip(instance.id, phase, { reason: "dependencies", dependsOn });
        continue;
      }

      if (node.progress !== undefined) {
        this.tracer.progress(instance.id, {
          node: node.name,
          stage: node.stage,
          progress: node.progress,
          description: node.description,
        }, events);
      }

      const startedAt = this.tracer.start(instance.id, phase);

      const result = await this.runNode(instance, session, events, turnChanges, node);
      if (isDependencyTrackedNode(node)) {
        this.recordEffectDependencies(instance, node, dependencyState.current);
      }

      if (result.changed) {
        changed = true;
      }

      this.tracer.done(instance.id, phase, startedAt, result.detail);
    }

    return changed;
  }

  private async runNode(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    node: WorkflowNode<JsonRecord>,
  ): Promise<NodeRunResult> {
    const changes = turnChanges.forWorkflow(instance.id);
    const contextRevision = instance.context.revision;
    const stepScope = this.createStepScope(instance, node, events);
    const input = this.nodeInput(instance, session, turnChanges, stepScope.controller);

    try {
      const result = node.kind === "prefetch"
        ? await this.runPrefetchNode(instance, node, input, changes, contextRevision, events)
        : node.kind === "effect"
          ? await this.runEffectNode(instance, node, input, changes, contextRevision, events)
          : await this.runLoopNode(instance, node, input, changes, contextRevision, events);
      stepScope.closeOpenSteps("done", { autoEnded: true });
      return result;
    } catch (error) {
      stepScope.closeOpenSteps("error", { autoEnded: true, error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Builds the runtime input visible to workflow predicates and node callbacks.
   * Input: current engine/session state plus turn-change tracking.
   * Output: a snapshot object passed to workflow-owned code.
   * Boundary: callers choose when to build the snapshot so turn data reflects the intended execution point.
   */
  private nodeInput(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    turnChanges: TurnChangeTracker,
    step: WorkflowStepController,
  ): WorkflowRuntimeInput<JsonRecord> {
    const changes = turnChanges.forWorkflow(instance.id);
    return {
      session,
      context: instance.context,
      state: instance.state,
      prefetch: instance.prefetch,
      deps: this.deps,
      turn: changes.snapshot(),
      step,
    };
  }

  /**
   * Runs a prefetch node and applies only read-through cache and tool-message side effects.
   * Input: runtime node input, turn-change tracking, and the context revision before node execution.
   * Output: node-change detail used for stabilization and tracing.
   * Boundary: prefetch nodes cannot patch workflow state directly; they expose fetched values through prefetch/context.
   */
  private async runPrefetchNode(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowPrefetchNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    changes: WorkflowTurnChanges,
    contextRevision: number,
    events: EngineEventSink,
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
    this.recordNodeTraceIfChanged(instance, node, detail, events);

    return { changed: detail.changed, detail };
  }

  /**
   * Runs an effect node and applies workflow state, message, context, and invalidation changes.
   * Input: runtime node input, turn-change tracking, and the context revision before node execution.
   * Output: node-change detail used for stabilization and tracing.
   * Boundary: irreversible external side effects happen inside node.run; this method only applies returned patches.
   */
  private async runEffectNode(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowEffectNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    changes: WorkflowTurnChanges,
    contextRevision: number,
    events: EngineEventSink,
  ): Promise<NodeRunResult> {
    const result = await node.run(input);
    return this.applyWorkflowPatchResult(instance, node, result, changes, contextRevision, events);
  }

  private applyWorkflowPatchResult(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowTraceNode,
    result: WorkflowPatch<JsonRecord> | void,
    changes: WorkflowTurnChanges,
    contextRevision: number,
    events: EngineEventSink,
  ): NodeRunResult {
    const appendedMessages = appendWorkflowMessages(instance.state, result?.messages ?? []);
    const contextChangedKeys = instance.context.changedKeysSince(contextRevision);
    if (!result) {
      changes.recordContext(contextChangedKeys);
      if (appendedMessages.length > 0) {
        changes.recordState(["messages"]);
      }
      const changed = contextChangedKeys.length > 0 || appendedMessages.length > 0;
      const detail = { changed, contextChangedKeys, appendedMessages: appendedMessages.length };
      this.recordNodeTraceIfChanged(instance, node, detail, events);
      return {
        changed,
        detail,
      };
    }

    const stateChanged = applyObjectPatch(instance.state, result.state ?? {});
    const invalidated = applyWorkflowInvalidation(
      instance,
      stateChanged,
      events,
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
    this.recordNodeTraceIfChanged(instance, node, detail, events);

    return { changed, detail };
  }

  private async runLoopNode(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowLoopNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    changes: WorkflowTurnChanges,
    _contextRevision: number,
    events: EngineEventSink,
  ): Promise<NodeRunResult> {
    const detail: LoopRunDetail = {
      changed: false,
      runs: 0,
      status: "max_runs",
      appendedMessages: 0,
      childChanged: false,
    };
    let latestReason: string | null = null;

    for (let run = 1; run <= node.maxRuns; run += 1) {
      detail.runs = run;
      const decision = await this.planLoopState(instance, node, input, run, events);
      latestReason = decision.reason;
      const appendedDecision = appendWorkflowMessage(instance.state, {
        role: "tool",
        name: `loop.${node.name}.state`,
        call: { loop: node.name, run },
        result: {
          status: decision.status,
          reason: decision.reason,
          state: decision.state,
        },
      });
      if (appendedDecision) {
        changes.recordState(["messages"]);
        detail.appendedMessages += 1;
        detail.changed = true;
      }

      if (decision.status === "satisfied" || decision.status === "blocked") {
        detail.status = decision.status;
        this.recordLoopCompletion(instance, node.name, {
          status: decision.status,
          runs: run,
          reason: decision.reason,
        });
        this.recordNodeTraceIfChanged(instance, node, detail, events);
        return { changed: detail.changed, detail };
      }

      if (decision.state === null) {
        throw new Error(`Workflow ${instance.id} loop ${node.name} continue decision must include state`);
      }

      const loopRuntime: WorkflowLoopRuntime<JsonRecord> = {
        name: node.name,
        run,
        maxRuns: node.maxRuns,
        state: decision.state,
        decisionReason: decision.reason,
        messages: instance.state.messages.filter((message): message is WorkflowToolMessage => message.role === "tool"),
      };
      const childResult = await this.runLoopEffects(instance, node, input, loopRuntime, changes, events);
      detail.childChanged = detail.childChanged || childResult.changed;
      detail.changed = detail.changed || childResult.changed;
    }

    this.recordLoopCompletion(instance, node.name, {
      status: "max_runs",
      runs: node.maxRuns,
      reason: latestReason,
    });
    this.recordNodeTraceIfChanged(instance, node, detail, events);
    return { changed: detail.changed, detail };
  }

  private async planLoopState(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowLoopNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    run: number,
    events: EngineEventSink,
  ): Promise<LoopDecision> {
    const schema = z.object({
      status: z.enum(["continue", "satisfied", "blocked"]),
      reason: z.string(),
      state: node.stateSchema.nullable(),
    });
    const phase = `llm.loop.${node.name}`;
    const startedAt = this.tracer.start(instance.id, phase, {
      loop: node.name,
      run,
      maxRuns: node.maxRuns,
      model: node.model ?? "default",
    });

    try {
      const decision = await this.deps.llm.structured({
        name: `${instance.id}_${node.name}_loop_state`,
        ...(node.model ? { model: node.model } : {}),
        instruction: loopInstructionForRuntime(instance.id, node, input.state, run),
        schema,
        messages: messagesForWorkflowMessages(input.state.messages),
      });
      if (decision.status === "continue" && decision.state === null) {
        throw new Error(`Workflow ${instance.id} loop ${node.name} continue decision must include state`);
      }
      if (decision.status !== "continue" && decision.state !== null) {
        throw new Error(`Workflow ${instance.id} loop ${node.name} ${decision.status} decision must use null state`);
      }
      this.tracer.done(instance.id, phase, startedAt, {
        loop: node.name,
        run,
        status: decision.status,
        reason: decision.reason,
      });
      this.tracer.trace({
        workflowId: instance.id,
        phase: "node.loop.state",
        detail: { loop: node.name, run, status: decision.status, reason: decision.reason },
      }, events);
      return decision as LoopDecision;
    } catch (error) {
      this.tracer.done(instance.id, phase, startedAt, {
        loop: node.name,
        run,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  private async runLoopEffects(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowLoopNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    loopRuntime: WorkflowLoopRuntime<JsonRecord>,
    changes: WorkflowTurnChanges,
    events: EngineEventSink,
  ): Promise<{ changed: boolean }> {
    let changed = false;
    const completed = new Set<string>(["loop.state"]);
    const pending = [...node.effects];

    while (pending.length > 0) {
      const index = pending.findIndex((effect) =>
        (effect.dependsOn ?? ["loop.state"]).every((dependency) => completed.has(dependency))
      );
      if (index < 0) {
        const blocked = pending.map((effect) => effect.name).join(", ");
        throw new Error(`Workflow ${instance.id} loop ${node.name} has unresolved loop effect dependencies: ${blocked}`);
      }

      const [effect] = pending.splice(index, 1);
      if (!effect) continue;
      const effectChanged = await this.runLoopEffect(instance, node, effect, input, loopRuntime, changes, events);
      changed = changed || effectChanged;
      completed.add(effect.name);
    }

    return { changed };
  }

  private async runLoopEffect(
    instance: WorkflowInstance<JsonRecord>,
    loopNode: WorkflowLoopNode<JsonRecord>,
    effect: WorkflowLoopEffectNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    loopRuntime: WorkflowLoopRuntime<JsonRecord>,
    changes: WorkflowTurnChanges,
    events: EngineEventSink,
  ): Promise<boolean> {
    const traceNode: WorkflowTraceNode = {
      name: `${loopNode.name}.${effect.name}`,
      stage: loopNode.stage,
    };
    const contextRevision = instance.context.revision;
    const stepScope = this.createStepScope(instance, traceNode, events);
    const childInput: WorkflowRuntimeInput<JsonRecord> = {
      ...input,
      state: instance.state,
      context: instance.context,
      prefetch: instance.prefetch,
      step: stepScope.controller,
    };
    const phase = `node.${loopNode.stage}.${loopNode.name}.${effect.name}`;
    const startedAt = this.tracer.start(instance.id, phase, {
      loop: loopNode.name,
      run: loopRuntime.run,
      effect: effect.name,
    });

    try {
      const result = await effect.run(childInput, loopRuntime);
      const applied = this.applyWorkflowPatchResult(instance, traceNode, result, changes, contextRevision, events);
      stepScope.closeOpenSteps("done", { autoEnded: true });
      this.tracer.done(instance.id, phase, startedAt, {
        loop: loopNode.name,
        run: loopRuntime.run,
        effect: effect.name,
        changed: applied.changed,
      });
      return applied.changed;
    } catch (error) {
      stepScope.closeOpenSteps("error", { autoEnded: true, error: errorMessage(error) });
      this.tracer.done(instance.id, phase, startedAt, {
        loop: loopNode.name,
        run: loopRuntime.run,
        effect: effect.name,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  private recordNodeTraceIfChanged(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowTraceNode,
    detail: NodeRunDetail,
    events: EngineEventSink,
  ): void {
    if (detail.changed) {
      this.tracer.trace({
        workflowId: instance.id,
        phase: `node.${node.stage}.${node.name}`,
        detail,
      }, events);
    }
  }

  private mergePrefetch(instance: WorkflowInstance<JsonRecord>, values: unknown): string[] {
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

  private effectDependencyState(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowNode<JsonRecord>,
  ): EffectDependencyState {
    if (!isDependencyTrackedNode(node) || node.dependsOn === undefined) {
      return { shouldRun: true };
    }

    const dependencyValues = this.dependencyValues(instance, node.dependsOn);
    if (!dependencyValues.ready) {
      return { shouldRun: false };
    }

    const current = dependencyValues.values;
    const previous = this.effectDependencyStore(instance).get(node.name);
    if (!previous || !sameDependencyValues(previous, current)) {
      return { shouldRun: true, current };
    }

    return { shouldRun: false };
  }

  private recordEffectDependencies(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowEffectNode<JsonRecord> | WorkflowLoopNode<JsonRecord>,
    current: readonly unknown[] | undefined,
  ): void {
    if (node.dependsOn === undefined || current === undefined) return;
    this.effectDependencyStore(instance).set(node.name, current);
  }

  private clearEffectDependenciesIfChanged(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowNode<JsonRecord>,
  ): void {
    const dependencyState = this.effectDependencyState(instance, node);
    if (isDependencyTrackedNode(node) && node.dependsOn !== undefined && dependencyState.shouldRun) {
      this.effectDependencyStore(instance).delete(node.name);
    }
  }

  private dependencyValues(
    instance: WorkflowInstance<JsonRecord>,
    dependsOn: readonly string[],
  ): { ready: true; values: readonly unknown[] } | { ready: false } {
    const values: unknown[] = [];
    for (const dependency of dependsOn) {
      if (dependency.startsWith("loop.")) {
        const completion = this.loopCompletionStore(instance).get(dependency.slice("loop.".length));
        if (!completion) return { ready: false };
        values.push(completion);
        continue;
      }
      values.push(instance.state[dependency]);
    }
    return { ready: true, values };
  }

  private recordLoopCompletion(
    instance: WorkflowInstance<JsonRecord>,
    loopName: string,
    completion: LoopCompletion,
  ): void {
    this.loopCompletionStore(instance).set(loopName, completion);
  }

  private loopCompletionStore(instance: WorkflowInstance<JsonRecord>): Map<string, LoopCompletion> {
    const existing = this.loopCompletions.get(instance);
    if (existing) return existing;

    const next = new Map<string, LoopCompletion>();
    this.loopCompletions.set(instance, next);
    return next;
  }

  private effectDependencyStore(instance: WorkflowInstance<JsonRecord>): Map<string, readonly unknown[]> {
    const existing = this.effectDependencies.get(instance);
    if (existing) return existing;

    const next = new Map<string, readonly unknown[]>();
    this.effectDependencies.set(instance, next);
    return next;
  }

  private createStepScope(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowTraceNode,
    events: EngineEventSink,
  ): WorkflowStepScope {
    let stepIndex = 0;
    const openSteps = new Map<string, TrackedStep>();

    const controller: WorkflowStepController = {
      start: (label, detail) => {
        if (!isNonEmptyString(label)) {
          throw new Error(`Workflow ${instance.id} step label must be a non-empty string`);
        }

        stepIndex += 1;
        const stepId = `${node.name}:${stepIndex}`;
        const trackedStep = { label, startedAt: Date.now() };
        openSteps.set(stepId, trackedStep);
        this.tracer.stepStart(instance.id, {
          node: node.name,
          stage: node.stage,
          stepId,
          label,
          ...(detail !== undefined ? { detail } : {}),
        }, events);

        return {
          id: stepId,
          label,
          end: (endDetail?: unknown) => {
            const openStep = openSteps.get(stepId);
            if (!openStep) return;
            openSteps.delete(stepId);
            this.tracer.stepEnd(instance.id, {
              node: node.name,
              stage: node.stage,
              stepId,
              label: openStep.label,
              status: "done",
              durationMs: Date.now() - openStep.startedAt,
              ...(endDetail !== undefined ? { detail: endDetail } : {}),
            }, events);
          },
        };
      },
    };

    return {
      controller,
      closeOpenSteps: (status, detail) => {
        for (const [stepId, openStep] of [...openSteps.entries()]) {
          openSteps.delete(stepId);
          this.tracer.stepEnd(instance.id, {
            node: node.name,
            stage: node.stage,
            stepId,
            label: openStep.label,
            status,
            durationMs: Date.now() - openStep.startedAt,
            ...(detail !== undefined ? { detail } : {}),
          }, events);
        }
      },
    };
  }
}

type NodeRunDetail = JsonRecord & {
  changed: boolean;
};

type LoopStatus = "satisfied" | "blocked" | "max_runs";

interface LoopCompletion {
  status: LoopStatus;
  runs: number;
  reason: string | null;
}

interface LoopDecision {
  status: "continue" | "satisfied" | "blocked";
  reason: string;
  state: JsonRecord | null;
}

type LoopRunDetail = NodeRunDetail & {
  runs: number;
  status: LoopStatus;
  appendedMessages: number;
  childChanged: boolean;
};

interface WorkflowTraceNode {
  name: string;
  stage: WorkflowNodeStage;
}

interface NodeRunResult {
  changed: boolean;
  detail: NodeRunDetail;
}

interface EffectDependencyState {
  shouldRun: boolean;
  current?: readonly unknown[];
}

interface TrackedStep {
  label: string;
  startedAt: number;
}

interface WorkflowStepScope {
  controller: WorkflowStepController;
  closeOpenSteps(status: "done" | "error", detail?: unknown): void;
}

const noopStepController: WorkflowStepController = {
  start(label) {
    return {
      id: "noop",
      label,
      end() {
        return undefined;
      },
    };
  },
};

function sameDependencyValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => sameRuntimeValue(value, right[index]));
}

function cloneEffectDependencies(
  dependencies: ReadonlyMap<string, readonly unknown[]>,
): Map<string, readonly unknown[]> {
  const clone = new Map<string, readonly unknown[]>();
  for (const [nodeName, values] of dependencies) {
    clone.set(nodeName, [...values]);
  }
  return clone;
}

function cloneLoopCompletions(
  completions: ReadonlyMap<string, LoopCompletion>,
): Map<string, LoopCompletion> {
  const clone = new Map<string, LoopCompletion>();
  for (const [loopName, completion] of completions) {
    clone.set(loopName, { ...completion });
  }
  return clone;
}

function isDependencyTrackedNode(
  node: WorkflowNode<JsonRecord>,
): node is WorkflowEffectNode<JsonRecord> | WorkflowLoopNode<JsonRecord> {
  return node.kind === "effect" || node.kind === "loop";
}

function dependencyNodeDependsOn(node: WorkflowNode<JsonRecord>): readonly string[] {
  return isDependencyTrackedNode(node) ? node.dependsOn ?? [] : [];
}

function loopInstructionForRuntime(
  workflowId: string,
  node: WorkflowLoopNode<JsonRecord>,
  state: JsonRecord,
  run: number,
): string {
  return [
    `Workflow ${workflowId} loop ${node.name} planner.`,
    "",
    "You are deciding the next internal loop state for this workflow turn.",
    "Return status=continue with a schema-valid state when another run of loop effects should execute.",
    "Return status=satisfied with state=null when the available evidence is enough.",
    "Return status=blocked with state=null when continuing would require unsupported scope, unsafe action, or user clarification.",
    `Current run: ${run} of ${node.maxRuns}.`,
    "",
    "Current workflow state:",
    safeJsonStringify(workflowStateForPrompt(state), 2),
    "",
    "Loop instruction:",
    node.instruction.trim(),
  ].join("\n");
}

function workflowStateForPrompt(state: JsonRecord): JsonRecord {
  const { messages: _messages, ...fields } = state;
  return fields;
}

function isPlainObject(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
