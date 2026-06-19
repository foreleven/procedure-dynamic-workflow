/**
 * Public engine facade and turn coordinator.
 *
 * This file owns registry validation, session entry points, routing orchestration,
 * per-turn transactions, and final transcript commit. It deliberately delegates
 * workflow-local execution, node semantics, response rendering, and route-plan
 * normalization to narrower runtime/routing modules so this class stays an
 * orchestrator rather than a second workflow runtime.
 */
import {
  type JsonRecord,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowMessage,
  type WorkflowUserMessage,
} from "@pac/workflow";
import { applySessionPatch } from "./patching.js";
import { WorkflowInstanceStore } from "./runtime/instances.js";
import {
  cloneEngineRoutingMemory,
  cloneEngineSessionForExtension,
  cloneEngineSessionRecord,
  createEngineSession,
} from "./session.js";
import {
  copyWorkflowMessages,
} from "./utils/messages.js";
import { TurnChangeTracker } from "./utils/turn.js";
import { ResponseRenderer } from "./runtime/response-renderer.js";
import { WorkflowNodeRunner } from "./runtime/node-runner.js";
import { RuntimeTracer } from "./runtime/tracer.js";
import {
  WorkflowTurnRunner,
  type WorkflowTurnRunnerRuntime,
  type WorkflowTurnRunResult,
} from "./runtime/workflow-turn-runner.js";
import { WorkflowExecutor } from "./runtime/workflow-executor.js";
import { WorkflowRenderer, type WorkflowRenderOutput } from "./runtime/workflow-renderer.js";
import { EngineEventStream } from "./runtime/events.js";
import { LlmWorkflowRouter } from "./routing/llm-workflow-router.js";
import { RoutingPlanApplier } from "./routing/routing-plan-applier.js";
import {
  normalizeWorkflowRoutingResult,
  type WorkflowRouter,
  type WorkflowRoutingResult,
} from "./routing/router.js";
import {
  firstDuplicate,
  toRuntimeWorkflow,
} from "./runtime/boundary.js";
import { errorMessage } from "./utils/errors.js";
import type {
  CreateSessionInput,
  EngineEventSink,
  EngineInvokeResult,
  EngineSession,
  EngineStreamEvent,
  EngineStreamPayload,
  EngineUserMessageInput,
  RuntimeWorkflow,
  WorkflowEngineOptions,
  WorkflowSnapshot,
} from "./types.js";

export class WorkflowEngine {
  private readonly registry = new Map<WorkflowId, RuntimeWorkflow>();
  private readonly instances: WorkflowInstanceStore;
  private readonly nodeRunner: WorkflowNodeRunner;
  private readonly renderer: ResponseRenderer;
  private readonly workflowExecutor: WorkflowExecutor;
  private readonly workflowRenderer: WorkflowRenderer;
  private readonly workflowRunnerRuntime: WorkflowTurnRunnerRuntime;
  private readonly tracer: RuntimeTracer;
  private readonly router: WorkflowRouter;
  private readonly routingPlanApplier = new RoutingPlanApplier();
  private readonly recentMessageLimit: number;
  private readonly now: (() => Date) | undefined;

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
    this.renderer = new ResponseRenderer(options.deps, this.tracer, options.render);
    this.workflowExecutor = new WorkflowExecutor();
    this.workflowRenderer = new WorkflowRenderer(this.renderer, this.tracer);
    this.workflowRunnerRuntime = {
      deps: options.deps,
      nodeRunner: this.nodeRunner,
      renderer: this.renderer,
      tracer: this.tracer,
    };
    this.router = options.routing?.router ?? new LlmWorkflowRouter({
      llm: options.deps.llm,
      gate: options.routing?.gate,
      candidateProvider: options.routing?.candidateProvider,
      gateModel: options.routing?.gateModel,
      minGateConfidence: options.routing?.minGateConfidence,
      maxWorkflowProfiles: options.routing?.maxWorkflowProfiles,
      recentMessageLimit: options.routing?.recentMessageLimit,
      now: options.deps.now,
    });
    this.recentMessageLimit = options.routing?.recentMessageLimit ?? 8;
    this.now = options.deps.now;
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

  async invoke(message: EngineUserMessageInput, session: EngineSession): Promise<EngineInvokeResult> {
    const messages: WorkflowMessage[] = [];
    const events: EngineStreamEvent[] = [];
    for await (const payload of this.stream(message, session)) {
      if ("message" in payload) {
        messages.push(payload.message);
      } else {
        events.push(payload.event);
      }
    }

    return { messages, events };
  }

  stream(message: EngineUserMessageInput, session: EngineSession): AsyncIterable<EngineStreamPayload> {
    const stream = new EngineEventStream();
    void this.runMessage(message, session, stream)
      .then(() => {
        stream.emit({
          event: {
            type: "engine.turn.done",
          },
        });
        stream.complete();
      })
      .catch((error: unknown) => {
        stream.fail(error);
      });
    return stream;
  }

  private async runMessage(
    message: EngineUserMessageInput,
    session: EngineSession,
    events: EngineEventSink,
  ): Promise<void> {
    const userMessage = normalizeUserMessageInput(message, this.now);
    const activeWorkflowError = this.validateActiveWorkflowIds(session.activeWorkflowIds);
    if (activeWorkflowError) {
      throw new Error(`Invalid engine session: ${activeWorkflowError}`);
    }

    const turnChanges = new TurnChangeTracker();
    const turnStartedAt = this.tracer.start("engine", "turn", { message: userMessage.content });
    const transaction = this.beginTurnTransaction(session);
    let responseTextChars = 0;

    try {
      const sessionMessagesBeforeTurn = copyWorkflowMessages(session.messages);
      const turnBaseMessages = [...sessionMessagesBeforeTurn, userMessage];
      const activeInstances = this.instances.forIds(session, session.activeWorkflowIds);
      const recentMessages = recentWorkflowMessages(session.messages, this.recentMessageLimit);
      const messageText = userMessage.content;

      const runnable = await this.selectTargetWorkflows(
        messageText,
        session,
        activeInstances,
        recentMessages,
        events,
      );
      if (runnable.length === 0) {
        const response = {
          text: "我还不能确定要执行哪个 workflow。",
        };
        const assistantMessage = assistantWorkflowMessage(response.text);
        this.commitSessionMessages(session, [...turnBaseMessages, assistantMessage]);
        events.emit({ message: assistantMessage });
        responseTextChars = response.text.length;
      } else {
        const execution = await this.runSelectedWorkflows(
          runnable,
          session,
          userMessage,
          events,
          turnChanges,
        );

        this.commitSessionMessages(
          session,
          this.sessionMessagesForCompletedWorkflows(
            session,
            turnBaseMessages,
            execution.workflowResults,
            execution.outputMessages,
          ),
        );
        session.routingMemory.lastMatchedWorkflowIds = runnable.map((instance) => instance.id);
        responseTextChars = execution.outputMessages.reduce((sum, item) => sum + assistantContentLength(item), 0);
      }
    } catch (error) {
      transaction.rollback();
      this.tracer.done("engine", "turn", turnStartedAt, { error: errorMessage(error) });
      throw error;
    }

    this.tracer.done("engine", "turn", turnStartedAt, { responseTextChars });
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
    events: EngineEventSink,
  ): Promise<WorkflowInstance<JsonRecord>[]> {
    const gatePhase = activeInstances.length > 0 ? "routing.gate.existing_session" : "routing.gate.new_session";
    const startedAt = this.tracer.start("engine", "routing", {
      mode: activeInstances.length > 0 ? "existing_session" : "new_session",
    });
    const rawResult = await this.router.route({
      message,
      session: cloneEngineSessionForExtension(session),
      workflows: [...this.registry.values()],
      activeInstances,
      recentMessages,
    });
    const result = normalizeWorkflowRoutingResult(
      rawResult,
      activeInstances.map((instance) => instance.id),
      new Set(this.registry.keys()),
    );
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
    this.tracer.trace({
      workflowId: "engine",
      phase,
      detail,
    }, events);
    this.tracer.trace({
      workflowId: "engine",
      phase: `routing.${result.action}`,
      detail,
    }, events);
    this.tracer.event("engine", phase, detail);
    this.tracer.done("engine", "routing", startedAt, detail);

    return selection;
  }

  /**
   * Starts every selected workflow independently and hands render handles to WorkflowRenderer.
   * Input: routed workflow instances and immutable per-turn execution context.
   * Output: rendered workflow results plus assistant messages for transcript commit.
   * Boundary: workflow-local execution, render scheduling, and response presentation stay in runtime helpers.
   */
  private async runSelectedWorkflows(
    runnable: readonly WorkflowInstance<JsonRecord>[],
    session: EngineSession,
    message: WorkflowUserMessage,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
  ): Promise<WorkflowRenderOutput> {
    const runners = runnable.map((instance) => new WorkflowTurnRunner(this.workflowRunnerRuntime, {
      instance,
      session,
      message,
      events,
      turnChanges,
    }));

    return await this.workflowRenderer.render({
      renders: this.workflowExecutor.execute(runners),
      instances: runnable,
      session,
      message: message.content,
      events,
    });
  }

  private sessionMessagesForCompletedWorkflows(
    session: EngineSession,
    turnBaseMessages: readonly WorkflowMessage[],
    workflowResults: readonly WorkflowTurnRunResult[],
    outputMessages: readonly WorkflowMessage[],
  ): WorkflowMessage[] {
    const runtimeMessages = workflowResults.flatMap((result) => result.deltaMessages);

    for (const result of workflowResults) {
      applySessionPatch(session, result.sessionPatch);
    }

    return [...turnBaseMessages, ...runtimeMessages, ...outputMessages];
  }

  private commitSessionMessages(session: EngineSession, messages: readonly WorkflowMessage[]): void {
    session.messages = copyWorkflowMessages(messages);
  }

  /**
   * Starts a turn-level transaction across session routing state, workflow instances,
   * and dependency-gated node memory.
   * Input: live session before routing or workflow execution mutates it.
   * Output: rollback handle used only when the turn fails.
   * Boundary: external side effects from connector/command code cannot be undone here.
   */
  private beginTurnTransaction(session: EngineSession): EngineTurnTransaction {
    const sessionCheckpoint = checkpointEngineSession(session);
    const instanceCheckpoint = this.instances.checkpoint(session);
    const nodeCheckpoint = this.nodeRunner.checkpoint([...instanceCheckpoint.instances.values()]);
    let rolledBack = false;

    return {
      rollback: () => {
        if (rolledBack) return;
        rolledBack = true;
        this.nodeRunner.restore(nodeCheckpoint);
        this.instances.restore(session, instanceCheckpoint);
        restoreEngineSession(session, sessionCheckpoint);
      },
    };
  }

}

interface EngineTurnTransaction {
  rollback(): void;
}

interface EngineSessionCheckpoint {
  readonly activeWorkflowIds: WorkflowId[];
  readonly messages: WorkflowMessage[];
  readonly facts: JsonRecord;
  readonly preferences: JsonRecord;
  readonly goals: string[];
  readonly constraints: string[];
  readonly hasConversationSummary: boolean;
  readonly conversationSummary: string | undefined;
  readonly sharedCacheEntries: readonly (readonly [string, unknown])[];
  readonly routingMemory: EngineSession["routingMemory"];
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

function normalizeUserMessageInput(
  input: EngineUserMessageInput,
  now: (() => Date) | undefined,
): WorkflowUserMessage {
  if (typeof input === "string") {
    if (!isNonEmptyString(input)) {
      throw new Error("Invalid message: message must be a non-empty string");
    }
    return {
      role: "user",
      content: input,
      timestamp: timestampNow(now),
    };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid message: message must be a non-empty string or user message");
  }
  if (input.role !== "user") {
    throw new Error("Invalid message: user message role must be user");
  }
  if (!isNonEmptyString(input.content)) {
    throw new Error("Invalid message: user message content must be a non-empty string");
  }
  if (input.id !== undefined && !isNonEmptyString(input.id)) {
    throw new Error("Invalid message: user message id must be a non-empty string");
  }

  return {
    ...definedFields(input),
    role: "user",
    content: input.content,
    timestamp: userMessageTimestamp(input, now),
  };
}

function userMessageTimestamp(
  message: WorkflowUserMessage,
  now: (() => Date) | undefined,
): number {
  const timestamp = message.timestamp;
  if (timestamp === undefined) return timestampNow(now);
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new Error("Invalid message: user message timestamp must be a finite number");
  }
  return timestamp;
}

function timestampNow(now: (() => Date) | undefined): number {
  return (now?.() ?? new Date()).getTime();
}

function definedFields(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function assistantWorkflowMessage(content: string, workflowId?: WorkflowId): WorkflowMessage {
  return workflowId === undefined
    ? { role: "assistant", content }
    : { role: "assistant", content, workflowId };
}

function assistantContentLength(message: WorkflowMessage): number {
  return message.role === "assistant" ? message.content.length : 0;
}

function checkpointEngineSession(session: EngineSession): EngineSessionCheckpoint {
  return {
    activeWorkflowIds: [...session.activeWorkflowIds],
    messages: copyWorkflowMessages(session.messages),
    facts: cloneEngineSessionRecord(session.facts),
    preferences: cloneEngineSessionRecord(session.preferences),
    goals: [...session.goals],
    constraints: [...session.constraints],
    hasConversationSummary: session.conversationSummary !== undefined,
    conversationSummary: session.conversationSummary,
    sharedCacheEntries: [...session.sharedCache.entries()],
    routingMemory: cloneEngineRoutingMemory(session.routingMemory),
  };
}

function restoreEngineSession(
  session: EngineSession,
  checkpoint: EngineSessionCheckpoint,
): void {
  session.activeWorkflowIds = [...checkpoint.activeWorkflowIds];
  session.messages = copyWorkflowMessages(checkpoint.messages);
  session.facts = cloneEngineSessionRecord(checkpoint.facts);
  session.preferences = cloneEngineSessionRecord(checkpoint.preferences);
  session.goals = [...checkpoint.goals];
  session.constraints = [...checkpoint.constraints];
  if (checkpoint.hasConversationSummary && checkpoint.conversationSummary !== undefined) {
    session.conversationSummary = checkpoint.conversationSummary;
  } else {
    delete session.conversationSummary;
  }

  session.sharedCache.clear();
  for (const [key, value] of checkpoint.sharedCacheEntries) {
    session.sharedCache.set(key, value);
  }
  session.routingMemory = cloneEngineRoutingMemory(checkpoint.routingMemory);
}

function isProtocolFastPathResult(result: WorkflowRoutingResult): boolean {
  return Boolean(
    result.detail &&
    typeof result.detail === "object" &&
    "reason" in result.detail &&
    (result.detail as { reason?: unknown }).reason === "ack_resolved",
  );
}
