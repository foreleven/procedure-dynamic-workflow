import {
  type JsonRecord,
  type RenderResponse,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowMessage,
  type WorkflowRuntimeState,
} from "@pac/workflow";
import { applySessionPatch, cloneDefault } from "./patching.js";
import { WorkflowInstanceStore } from "./runtime/instances.js";
import { createEngineSession } from "./session.js";
import {
  copyWorkflowMessages,
  withRuntimeMessages,
} from "./utils/messages.js";
import { TurnChangeTracker } from "./utils/turn.js";
import { ResponseRenderer, type MergedResponseParticipant } from "./runtime/response-renderer.js";
import { WorkflowNodeRunner } from "./runtime/node-runner.js";
import { RuntimeTracer } from "./runtime/tracer.js";
import { WorkflowTurnRunner, type WorkflowTurnRunResult } from "./runtime/workflow-turn-runner.js";
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
  RuntimeWorkflow,
  TargetSelection,
  WorkflowEngineOptions,
  WorkflowSnapshot,
} from "./types.js";

export class WorkflowEngine {
  private readonly registry = new Map<WorkflowId, RuntimeWorkflow>();
  private readonly instances: WorkflowInstanceStore;
  private readonly nodeRunner: WorkflowNodeRunner;
  private readonly renderer: ResponseRenderer;
  private readonly workflowRunner: WorkflowTurnRunner;
  private readonly tracer: RuntimeTracer;
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

    this.instances = new WorkflowInstanceStore(this.registry, options.deps.connectors);
    this.tracer = new RuntimeTracer(options.logger);
    this.nodeRunner = new WorkflowNodeRunner(options.deps, this.tracer, options.maxProgramRounds ?? 6);
    this.renderer = new ResponseRenderer(options.deps, this.tracer, options.onResponseDelta, options.render);
    this.workflowRunner = new WorkflowTurnRunner(options.deps, this.nodeRunner, this.renderer, this.tracer);
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
    const sessionMessagesBeforeTurn = copyWorkflowMessages(session.messages);
    const turnBaseMessages = [...sessionMessagesBeforeTurn, userWorkflowMessage(message)];
    const activeInstances = this.instances.forIds(session, session.activeWorkflowIds);
    const recentMessages = recentWorkflowMessages(session.messages, this.recentMessageLimit);

    const targets = await this.selectTargetWorkflows(message, session, activeInstances, recentMessages, traces);
    const preStates = new Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>(
      targets.instances.map((instance) => [
        instance.id,
        withRuntimeMessages(cloneDefault(instance.state), instance.state.messages),
      ]),
    );
    const runnable = targets.instances;

    if (runnable.length === 0) {
      const response = {
        text: "我还不能确定要执行哪个 workflow。",
      };
      this.commitSessionMessages(session, [...turnBaseMessages, assistantWorkflowMessage(response.text)]);
      this.tracer.done("engine", "turn", turnStartedAt, { responseTextChars: response.text.length });
      const result = {
        response,
        responses: [],
        session,
        traces,
      };
      return result;
    }

    const shouldMergeFinalResponse = await this.shouldMergeWorkflowResponses(runnable, session, message);
    const workflowResults = await Promise.all(
      runnable.map((instance) =>
        this.workflowRunner.run({
          instance,
          session,
          message,
          traces,
          turnChanges,
          preStates,
          streamResponseDeltas: !shouldMergeFinalResponse,
        }),
      ),
    );

    const responses = workflowResults.map(({ workflowId, response }) => ({ workflowId, response }));
    const finalResponse = await this.finalResponseForWorkflowResults(
      workflowResults,
      session,
      message,
      traces,
      shouldMergeFinalResponse,
    );

    this.commitSessionMessages(
      session,
      this.sessionMessagesForCompletedWorkflows(
        session,
        turnBaseMessages,
        workflowResults,
        finalResponse,
      ),
    );
    session.routingMemory.lastMatchedWorkflowIds = runnable.map((instance) => instance.id);

    this.tracer.done("engine", "turn", turnStartedAt, { responseTextChars: finalResponse.text.length });

    const result = {
      response: finalResponse,
      responses,
      session,
      traces,
    };
    return result;
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
    activeInstances: WorkflowInstance<JsonRecord>[],
    recentMessages: readonly WorkflowMessage[],
    traces: EngineTraceEvent[],
  ): Promise<TargetSelection> {
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

    return selection;
  }

  private async finalResponseForWorkflowResults(
    workflowResults: readonly WorkflowTurnRunResult[],
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    shouldMergeFinalResponse: boolean,
  ): Promise<RenderResponse> {
    const primaryResponse = workflowResults[0]?.response ?? { text: "" };
    if (
      workflowResults.length <= 1 ||
      !shouldMergeFinalResponse
    ) {
      return primaryResponse;
    }

    const participants: MergedResponseParticipant[] = workflowResults.map((result) => ({
      workflowId: result.workflowId,
      description: result.description,
      response: result.response,
    }));
    const workflowIds = participants.map(({ workflowId }) => workflowId);
    const startedAt = this.tracer.start("engine", "response.merge", { workflowIds });
    const response = await this.renderer.mergeRenderedResponses(participants, session, message);
    const detail = { workflowIds, textChars: response.text.length };
    traces.push({
      workflowId: "engine",
      phase: "response.merge",
      detail,
    });
    this.tracer.done("engine", "response.merge", startedAt, detail);
    return response;
  }

  private async shouldMergeWorkflowResponses(
    instances: readonly WorkflowInstance<JsonRecord>[],
    session: EngineSession,
    message: string,
  ): Promise<boolean> {
    if (instances.length <= 1) return false;
    if (instances.some((instance) => typeof instance.artifact.render === "function")) return false;
    const decision = await this.renderer.mergeDecision(session, message, instances);
    return decision === "merge";
  }

  private sessionMessagesForCompletedWorkflows(
    session: EngineSession,
    turnBaseMessages: readonly WorkflowMessage[],
    workflowResults: readonly WorkflowTurnRunResult[],
    finalResponse: RenderResponse,
  ): WorkflowMessage[] {
    const runtimeMessages = workflowResults.flatMap((result) => result.deltaMessages);
    const assistantMessages = [assistantWorkflowMessage(finalResponse.text)];

    for (const result of workflowResults) {
      applySessionPatch(session, result.sessionPatch);
    }

    return [...turnBaseMessages, ...runtimeMessages, ...assistantMessages];
  }

  private commitSessionMessages(session: EngineSession, messages: readonly WorkflowMessage[]): void {
    session.messages = copyWorkflowMessages(messages);
  }

}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function recentWorkflowMessages(
  messages: readonly WorkflowMessage[],
  limit: number,
): WorkflowMessage[] {
  if (limit <= 0) return [];
  return messages.slice(Math.max(0, messages.length - limit));
}

function userWorkflowMessage(content: string): WorkflowMessage {
  return { role: "user", content };
}

function assistantWorkflowMessage(content: string): WorkflowMessage {
  return { role: "assistant", content };
}

function isProtocolFastPathResult(result: WorkflowRoutingResult): boolean {
  return Boolean(
    result.detail &&
    typeof result.detail === "object" &&
    "reason" in result.detail &&
    (result.detail as { reason?: unknown }).reason === "ack_resolved",
  );
}
