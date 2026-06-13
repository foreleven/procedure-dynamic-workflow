import {
  type JsonRecord,
  type MessagePatch,
  type WorkflowId,
  type WorkflowRuntimeState,
} from "@pac/workflow";
import { cloneDefault, normalizeMessagePatch } from "./patching.js";
import { errorMessage } from "./utils/errors.js";
import { scoreWorkflow } from "./routing.js";
import { RuntimeInstanceStore } from "./runtime/instances.js";
import { createEngineSession } from "./session.js";
import {
  appendWorkflowMessage,
  messagesForPatch,
  withRuntimeMessages,
} from "./utils/messages.js";
import { TurnChangeTracker } from "./utils/turn.js";
import { ResponseRenderer } from "./runtime/response-renderer.js";
import { WorkflowNodeRunner } from "./runtime/node-runner.js";
import { applyWorkflowInvalidation, applyWorkflowMessagePatch } from "./runtime/mutations.js";
import { RuntimeTracer } from "./runtime/tracer.js";
import {
  firstDuplicate,
  toRuntimeWorkflow,
} from "./runtime/boundary.js";
import type {
  CreateSessionInput,
  EngineSession,
  EngineTraceEvent,
  EngineTurnResult,
  RuntimeInstance,
  RuntimeWorkflow,
  TargetSelection,
  WorkflowEngineOptions,
  WorkflowSnapshot,
} from "./types.js";

export class WorkflowEngine {
  private readonly registry = new Map<WorkflowId, RuntimeWorkflow>();
  private readonly instances: RuntimeInstanceStore;
  private readonly nodeRunner: WorkflowNodeRunner;
  private readonly renderer: ResponseRenderer;
  private readonly tracer: RuntimeTracer;
  private readonly deps: WorkflowEngineOptions["deps"];

  constructor(options: WorkflowEngineOptions) {
    if (options.maxProgramRounds !== undefined && !isPositiveInteger(options.maxProgramRounds)) {
      throw new Error("maxProgramRounds must be a positive integer");
    }

    for (const candidate of options.workflows) {
      const workflow = toRuntimeWorkflow(candidate);
      if (this.registry.has(workflow.id)) {
        throw new Error(`Duplicate workflow id: ${workflow.id}`);
      }

      this.registry.set(workflow.id, workflow);
    }

    this.deps = options.deps;
    this.instances = new RuntimeInstanceStore(this.registry, options.deps.connectors);
    this.tracer = new RuntimeTracer(options.logger);
    this.nodeRunner = new WorkflowNodeRunner(options.deps, this.tracer, options.maxProgramRounds ?? 6);
    this.renderer = new ResponseRenderer(options.deps, this.tracer, options.onResponseDelta);
  }

  createSession(input: CreateSessionInput): EngineSession {
    const duplicateWorkflowId = firstDuplicate(input.activeWorkflowIds ?? []);
    if (duplicateWorkflowId) {
      throw new Error(`Duplicate active workflow id: ${duplicateWorkflowId}`);
    }

    const unknownWorkflowIds = (input.activeWorkflowIds ?? []).filter((workflowId) => !this.registry.has(workflowId));
    if (unknownWorkflowIds.length > 0) {
      throw new Error(`Unknown active workflow id(s): ${unknownWorkflowIds.join(", ")}`);
    }

    const session = createEngineSession(input);
    this.instances.initializeSession(session);
    return session;
  }

  async onMessage(message: string, session: EngineSession): Promise<EngineTurnResult> {
    if (!isNonEmptyString(message)) {
      throw new Error("Invalid message: message must be a non-empty string");
    }
    const activeWorkflowError = this.validateActiveWorkflowIds(session.activeWorkflowIds);
    if (activeWorkflowError) {
      throw new Error(`Invalid engine session: ${activeWorkflowError}`);
    }

    const traces: EngineTraceEvent[] = [];
    const turnChanges = new TurnChangeTracker();
    const turnStartedAt = this.tracer.start("engine", "turn", { message });

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
        this.nodeRunner.runStageOnce(instance, session, message, traces, turnChanges, preStates, "beforePatch"),
      ),
    );

    await Promise.all(
      targets.instances.map((instance) =>
        this.nodeRunner.runStageOnce(instance, session, message, traces, turnChanges, preStates, "withPatch"),
      ),
    );
    const patches = await Promise.all(
      targets.instances.map((instance) => this.extractPatch(instance, traces)),
    );

    this.applyPatches(targets.instances, patches, session, traces, turnChanges);

    const runnable = this.instances.forActiveTargets(session, targets.ids);
    for (const instance of runnable) {
      await this.nodeRunner.runStageUntilStable(instance, session, message, traces, turnChanges, preStates, "afterPatch");
    }

    const responses = await this.renderer.renderResponses(runnable, session, message, traces, turnChanges, preStates);
    session.routingMemory.lastMatchedWorkflowIds = runnable.map((instance) => instance.id);

    this.tracer.done("engine", "turn", turnStartedAt, { responseTextChars: responses[0]?.response.text.length ?? 0 });

    return {
      response: responses[0]?.response ?? {
        text: "我还不能确定要执行哪个 workflow。",
      },
      responses,
      session,
      traces,
    };
  }

  getWorkflowSnapshot<TState extends object>(
    session: EngineSession,
    workflowId: WorkflowId,
  ): WorkflowSnapshot<TState> | undefined {
    return this.instances.snapshot(session, workflowId);
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

  private selectTargetWorkflows(
    message: string,
    session: EngineSession,
    traces: EngineTraceEvent[],
  ): TargetSelection {
    if (session.activeWorkflowIds.length > 0) {
      const startedAt = this.tracer.start("engine", "routing.active");
      const instances = this.instances.forIds(session, session.activeWorkflowIds);
      traces.push({
        workflowId: instances[0]?.id ?? "none",
        phase: "routing.active",
        detail: instances.map((instance) => instance.id),
      });
      this.tracer.done("engine", "routing.active", startedAt, instances.map((instance) => instance.id));

      return {
        instances,
        ids: new Set(instances.map((instance) => instance.id)),
      };
    }

    const startedAt = this.tracer.start("engine", "routing.local");
    const best = this.findBestWorkflow(message);
    if (!best) {
      traces.push({ workflowId: "none", phase: "routing.none" });
      this.tracer.done("engine", "routing.local", startedAt, { matched: false });
      return { instances: [], ids: new Set() };
    }

    this.instances.attach(session, best.workflow.id);
    const instance = this.instances.ensure(session, best.workflow.id);
    const instances = instance ? [instance] : [];

    traces.push({
      workflowId: best.workflow.id,
      phase: "routing.local",
      detail: { score: best.score },
    });
    this.tracer.done("engine", "routing.local", startedAt, { workflowId: best.workflow.id, score: best.score });

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
      this.tracer.progress(traces, instance.id, {
        node: name,
        stage: "patch",
        progress: instance.artifact.patch.progress,
        description: "Extract structured workflow state from the latest user message.",
      });
    }
    const startedAt = this.tracer.start(instance.id, "llm.patch", {
      name,
      model: instance.artifact.patch.model ?? "default",
    });

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
      this.tracer.done(instance.id, "llm.patch", startedAt, normalized);
      return normalized;
    } catch (error) {
      this.tracer.done(instance.id, "llm.patch", startedAt, { error: errorMessage(error) });
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
      const dirtyFields = applyWorkflowMessagePatch(instance, session, patch, traces);
      const changes = turnChanges.forWorkflow(instance.id);
      changes.recordMessagePatchState(Object.keys(patch.statePatch ?? {}));
      const invalidated = applyWorkflowInvalidation(instance, dirtyFields, traces);
      changes.recordState(dirtyFields);
      changes.recordInvalidatedState(invalidated);
    }
  }

}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function patchInstructionForRuntime(instruction: string, now: string): string {
  return `${instruction}

Runtime boundary:
- Current time is ${now}.
- Use the current time only to resolve relative dates and times from the message log.`;
}
