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
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowNode,
  type WorkflowNodeStage,
  type WorkflowPrefetchNode,
  type WorkflowRuntimeInput,
  type WorkflowRuntimeState,
  type WorkflowStepController,
} from "@pac/workflow";
import { applyObjectPatch } from "../patching.js";
import { applyWorkflowInvalidation } from "./mutations.js";
import type { EngineEventSink, EngineSession, EngineTraceEvent, WorkflowEngineOptions } from "../types.js";
import { RuntimeTracer } from "./tracer.js";
import { errorMessage } from "../utils/errors.js";
import { sameRuntimeValue } from "../utils/json.js";
import { appendWorkflowMessage, appendWorkflowMessages } from "../utils/messages.js";
import { preStateFor } from "../utils/state.js";
import { TurnChangeTracker, type WorkflowTurnChanges } from "../utils/turn.js";

export interface WorkflowNodeRunnerCheckpoint {
  readonly effectDependencies: ReadonlyMap<
    WorkflowInstance<JsonRecord>,
    Map<string, readonly unknown[]> | undefined
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

    for (const instance of instances) {
      const dependencies = this.effectDependencies.get(instance);
      effectDependencies.set(
        instance,
        dependencies === undefined ? undefined : cloneEffectDependencies(dependencies),
      );
    }

    return { effectDependencies };
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
  }

  /**
   * Runs one node stage exactly once.
   * Input: a runtime instance, current session/message, trace sink, turn changes, pre-turn states, and stage.
   * Output: node side effects applied to the runtime instance.
   * Boundary: used for beforePatch and withPatch stages where stabilization is not desired.
   */
  async runStageOnce(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    stage: WorkflowNodeStage,
  ): Promise<void> {
    await this.runStageRound(instance, session, message, traces, events, turnChanges, preStates, stage);
  }

  /**
   * Runs one node stage until no node reports a semantic change or the round limit is reached.
   * Input: a runtime instance, current session/message, trace sink, turn changes, pre-turn states, and stage.
   * Output: node side effects applied across stabilization rounds.
   * Boundary: max-round exhaustion is traced instead of throwing so callers can still render diagnostics.
   */
  async runStageUntilStable(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    stage: WorkflowNodeStage,
  ): Promise<void> {
    for (let round = 0; round < this.maxProgramRounds; round += 1) {
      const phase = `nodes.${stage}.round`;
      const startedAt = this.tracer.start(instance.id, phase, { round });

      const changed = await this.runStageRound(instance, session, message, traces, events, turnChanges, preStates, stage);
      this.tracer.done(instance.id, phase, startedAt, { round, changed });

      if (!changed) return;
    }

    this.tracer.trace(traces, {
      workflowId: instance.id,
      phase: `nodes.${stage}.maxRounds`,
      detail: { maxProgramRounds: this.maxProgramRounds },
    }, events);
  }

  private async runStageRound(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    stage: WorkflowNodeStage,
  ): Promise<boolean> {
    let changed = false;

    for (const node of instance.artifact.nodes) {
      if (node.stage !== stage) continue;

      const phase = `node.${stage}.${node.name}`;
      const input = this.nodeInput(instance, session, message, turnChanges, preStates, noopStepController);

      if (node.when && !(await node.when(input))) {
        this.clearEffectDependenciesIfChanged(instance, node);
        this.tracer.trace(traces, {
          workflowId: instance.id,
          phase: `${phase}.skip`,
          detail: { reason: "when" },
        }, events);
        this.tracer.skip(instance.id, phase, { reason: "when" });
        continue;
      }

      const dependencyState = this.effectDependencyState(instance, node);
      if (!dependencyState.shouldRun) {
        const dependsOn = node.kind === "effect" ? node.dependsOn ?? [] : [];
        this.tracer.trace(traces, {
          workflowId: instance.id,
          phase: `${phase}.skip`,
          detail: { reason: "dependencies", dependsOn },
        }, events);
        this.tracer.skip(instance.id, phase, { reason: "dependencies", dependsOn });
        continue;
      }

      if (node.progress !== undefined) {
        this.tracer.progress(traces, instance.id, {
          node: node.name,
          stage: node.stage,
          progress: node.progress,
          description: node.description,
        }, events);
      }

      const startedAt = this.tracer.start(instance.id, phase);

      const result = await this.runNode(instance, session, message, traces, events, turnChanges, preStates, node);
      if (node.kind === "effect") {
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
    message: string,
    traces: EngineTraceEvent[],
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    node: WorkflowNode<JsonRecord>,
  ): Promise<NodeRunResult> {
    const changes = turnChanges.forWorkflow(instance.id);
    const contextRevision = instance.context.revision;
    const stepScope = this.createStepScope(instance, node, traces, events);
    const input = this.nodeInput(instance, session, message, turnChanges, preStates, stepScope.controller);

    try {
      const result = node.kind === "prefetch"
        ? await this.runPrefetchNode(instance, node, input, changes, contextRevision, traces, events)
        : await this.runEffectNode(instance, node, input, changes, contextRevision, traces, events);
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
    message: string,
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    step: WorkflowStepController,
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
      step,
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
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowPrefetchNode<JsonRecord>,
    input: WorkflowRuntimeInput<JsonRecord>,
    changes: WorkflowTurnChanges,
    contextRevision: number,
    traces: EngineTraceEvent[],
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
    this.recordNodeTraceIfChanged(instance, node, detail, traces, events);

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
    traces: EngineTraceEvent[],
    events: EngineEventSink,
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
      this.recordNodeTraceIfChanged(instance, node, detail, traces, events);
      return {
        changed,
        detail,
      };
    }

    const stateChanged = applyObjectPatch(instance.state, result.state ?? {});
    const invalidated = applyWorkflowInvalidation(
      instance,
      stateChanged,
      traces,
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
    this.recordNodeTraceIfChanged(instance, node, detail, traces, events);

    return { changed, detail };
  }

  private recordNodeTraceIfChanged(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowNode<JsonRecord>,
    detail: NodeRunDetail,
    traces: EngineTraceEvent[],
    events: EngineEventSink,
  ): void {
    if (detail.changed) {
      this.tracer.trace(traces, {
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
    if (node.kind !== "effect" || node.dependsOn === undefined) {
      return { shouldRun: true };
    }

    const current = node.dependsOn.map((field) => instance.state[field]);
    const previous = this.effectDependencyStore(instance).get(node.name);
    if (!previous || !sameDependencyValues(previous, current)) {
      return { shouldRun: true, current };
    }

    return { shouldRun: false };
  }

  private recordEffectDependencies(
    instance: WorkflowInstance<JsonRecord>,
    node: WorkflowEffectNode<JsonRecord>,
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
    if (node.kind === "effect" && node.dependsOn !== undefined && dependencyState.shouldRun) {
      this.effectDependencyStore(instance).delete(node.name);
    }
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
    node: WorkflowNode<JsonRecord>,
    traces: EngineTraceEvent[],
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
        this.tracer.stepStart(traces, instance.id, {
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
            this.tracer.stepEnd(traces, instance.id, {
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
          this.tracer.stepEnd(traces, instance.id, {
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

function isPlainObject(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
