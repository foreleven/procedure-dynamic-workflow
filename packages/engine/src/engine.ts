import {
  type JsonRecord,
  type MessagePatch,
  type WorkflowId,
  type WorkflowMessage,
  type WorkflowRuntimeState,
} from "@pac/workflow";
import { cloneDefault, normalizeMessagePatch } from "./patching.js";
import { errorMessage } from "./utils/errors.js";
import { safeJsonStringify } from "./utils/json.js";
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
import { LlmWorkflowRouter } from "./routing/llm-workflow-router.js";
import { RoutingPlanApplier } from "./routing/routing-plan-applier.js";
import type { WorkflowRouter, WorkflowRoutingResult } from "./routing/router.js";
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
  private readonly router: WorkflowRouter;
  private readonly routingPlanApplier = new RoutingPlanApplier();
  private readonly recentMessageLimit: number;

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
    this.router = options.routing?.router ?? new LlmWorkflowRouter({
      llm: options.deps.llm,
      gate: options.routing?.gate,
      candidateProvider: options.routing?.candidateProvider,
      gateModel: options.routing?.gateModel,
      minGateConfidence: options.routing?.minGateConfidence,
      maxWorkflowProfiles: options.routing?.maxWorkflowProfiles,
      recentMessageLimit: options.routing?.recentMessageLimit,
    });
    this.recentMessageLimit = options.routing?.recentMessageLimit ?? 8;
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
    const activeInstances = this.instances.forIds(session, session.activeWorkflowIds);
    const recentMessages = recentWorkflowMessages(activeInstances, this.recentMessageLimit);
    const speculativePatchPromise = this.extractSpeculativeActivePatches(message, activeInstances);

    const routed = await this.selectTargetWorkflows(message, session, activeInstances, recentMessages, traces);
    const targets = routed.selection;
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
    const patches = await this.extractTargetPatches(
      targets.instances,
      routed.result,
      speculativePatchPromise,
      traces,
    );

    this.applyPatches(targets.instances, patches, session, traces, turnChanges);

    const runnable = this.instances.forActiveTargets(session, targets.ids);
    await Promise.all(
      runnable.map((instance) =>
        this.nodeRunner.runStageUntilStable(instance, session, message, traces, turnChanges, preStates, "afterPatch"),
      ),
    );

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

  private async selectTargetWorkflows(
    message: string,
    session: EngineSession,
    activeInstances: RuntimeInstance[],
    recentMessages: readonly WorkflowMessage[],
    traces: EngineTraceEvent[],
  ): Promise<RoutedTargetSelection> {
    const gatePhase = activeInstances.length > 0 ? "routing.gate.existing_session" : "routing.gate.new_session";
    const startedAt = this.tracer.start("engine", "routing", {
      mode: activeInstances.length > 0 ? "existing_session" : "new_session",
    });
    const result = await this.router.route({
      message,
      session,
      workflows: [...this.registry.values()],
      activeInstances,
      recentMessages,
    });
    const selection = this.routingPlanApplier.apply({
      session,
      instances: this.instances,
      activeInstances,
      result,
    });

    const detail = {
      action: result.action,
      targetWorkflowIds: result.targetWorkflowIds,
      suspendedWorkflowIds: result.suspendedWorkflowIds,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    };
    const phase = isProtocolFastPathResult(result) ? "routing.protocol_fast_path" : gatePhase;
    traces.push({
      workflowId: "engine",
      phase,
      detail,
    });
    traces.push({
      workflowId: "engine",
      phase: `routing.${result.action}`,
      detail,
    });
    this.tracer.event("engine", phase, detail);
    this.tracer.done("engine", "routing", startedAt, detail);

    return { selection, result };
  }

  private async extractPatch(
    instance: RuntimeInstance,
    traces: EngineTraceEvent[],
    state: WorkflowRuntimeState<JsonRecord> = instance.state,
    mode: "live" | "speculative" = "live",
  ): Promise<MessagePatch> {
    const name = `${instance.id}_patch`;
    if (mode === "live" && instance.artifact.patch.progress) {
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
      const now = (new Date()).toISOString();
      const patch = await this.deps.llm.structured({
        name,
        ...(instance.artifact.patch.model ? { model: instance.artifact.patch.model } : {}),
        instruction: patchInstructionForRuntime(instance.artifact.patch.instruction, now, state),
        schema: instance.artifact.patch.schema,
        messages: messagesForPatch(state),
      });

      const normalized = normalizeMessagePatch(patch);
      this.tracer.done(instance.id, "llm.patch", startedAt, normalized);
      return normalized;
    } catch (error) {
      this.tracer.done(instance.id, "llm.patch", startedAt, { error: errorMessage(error) });
      throw error;
    }
  }

  private extractSpeculativeActivePatches(
    message: string,
    activeInstances: readonly RuntimeInstance[],
  ): Promise<SpeculativePatchResult[]> | undefined {
    if (activeInstances.length === 0) return undefined;
    return Promise.all(
      activeInstances.map(async (instance): Promise<SpeculativePatchResult> => {
        const transientState = withRuntimeMessages(cloneDefault(instance.state));
        appendWorkflowMessage(transientState, { role: "user", content: message });
        try {
          return {
            workflowId: instance.id,
            patch: await this.extractPatch(instance, [], transientState, "speculative"),
          };
        } catch (error) {
          return {
            workflowId: instance.id,
            error,
          };
        }
      }),
    );
  }

  private async extractTargetPatches(
    instances: RuntimeInstance[],
    routingResult: WorkflowRoutingResult,
    speculativePatchPromise: Promise<SpeculativePatchResult[]> | undefined,
    traces: EngineTraceEvent[],
  ): Promise<MessagePatch[]> {
    const speculativeByWorkflow = new Map<WorkflowId, SpeculativePatchResult>();
    if (
      speculativePatchPromise &&
      (routingResult.action === "continue" || routingResult.action === "parallel")
    ) {
      for (const result of await speculativePatchPromise) {
        speculativeByWorkflow.set(result.workflowId, result);
      }
    } else if (speculativePatchPromise) {
      void speculativePatchPromise;
      traces.push({
        workflowId: "engine",
        phase: "routing.speculative_patch.discard",
        detail: { action: routingResult.action },
      });
    }

    return Promise.all(
      instances.map((instance) => {
        const speculative = speculativeByWorkflow.get(instance.id);
        if (speculative) {
          if ("error" in speculative) {
            throw speculative.error;
          }
          return speculative.patch;
        }
        return this.extractPatch(instance, traces);
      }),
    );
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

interface RoutedTargetSelection {
  selection: TargetSelection;
  result: WorkflowRoutingResult;
}

type SpeculativePatchResult =
  | {
      workflowId: WorkflowId;
      patch: MessagePatch;
    }
  | {
      workflowId: WorkflowId;
      error: unknown;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function recentWorkflowMessages(
  instances: readonly RuntimeInstance[],
  limit: number,
): WorkflowMessage[] {
  if (limit <= 0) return [];
  const messages = instances.flatMap((instance) => instance.state.messages);
  return messages.slice(Math.max(0, messages.length - limit));
}

function patchInstructionForRuntime(instruction: string, now: string, state: JsonRecord): string {
  return [
    "PAC Patch system prompt:",
    "You are the Patch phase of a PAC workflow runtime. Your core job is to advance workflow state.",
    "",
    "Patch responsibilities:",
    "- Read the full conversation history, runtime tool facts, and current workflow state.",
    "- Treat the latest user message as the only source of new user-provided facts for this turn.",
    "- Use prior assistant messages, runtime tool facts, and current state only to resolve references, selections, confirmations, or corrections.",
    "- Produce the minimal structured state/session delta needed to move the workflow forward after the latest user turn.",
    "- If the latest user turn does not advance state, return a valid empty/no-op patch according to the schema.",
    "- Preserve previously collected facts unless the latest user message explicitly changes, rejects, or corrects them.",
    "",
    "Patch prohibitions:",
    "- Do not compose a user-facing reply; Render owns wording and user-visible content.",
    "- Do not call connectors, simulate connector calls, invent records, invent available options, or invent external facts.",
    "- Do not emit XML, DSML, JSON text, markdown, narration, or tool-call markup outside the required structured-output tool.",
    "- Do not copy current-state fields into the patch only because they already exist; output a delta, not a snapshot.",
    "",
    "Workflow-authored Patch instructions:",
    instruction.trim(),
    "",
    "PAC Patch runtime context:",
    `- Current time is ${now}.`,
    "- Use the current time only to resolve relative dates and times from the message log.",
    "",
    "Current workflow state before patch:",
    safeJsonStringify(stateForPatch(state), 2),
  ].join("\n");
}

function stateForPatch(state: JsonRecord): JsonRecord {
  const snapshot: JsonRecord = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === "messages") continue;
    snapshot[key] = value;
  }
  return snapshot;
}

function isProtocolFastPathResult(result: WorkflowRoutingResult): boolean {
  return Boolean(
    result.detail &&
    typeof result.detail === "object" &&
    "reason" in result.detail &&
    (result.detail as { reason?: unknown }).reason === "ack_resolved",
  );
}
