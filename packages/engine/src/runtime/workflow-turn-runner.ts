/**
 * Workflow-local turn lifecycle.
 *
 * This runner owns the order inside one selected workflow instance:
 * beforePatch -> withPatch -> structured patch -> invalidation -> afterPatch -> render.
 * It mutates only the supplied workflow instance and a workflow-local session view;
 * engine-level routing state and transcript commit remain outside this file.
 */
import {
  type JsonRecord,
  type MessagePatch,
  type RenderResponse,
  type SessionPatch,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowMessage,
  type WorkflowRuntimeState,
  type WorkflowToolMessage,
  type WorkflowUserMessage,
} from "@pac/workflow";
import { normalizeMessagePatch } from "../patching.js";
import { errorMessage } from "../utils/errors.js";
import { safeJsonStringify } from "../utils/json.js";
import {
  appendWorkflowMessage,
  copyWorkflowMessages,
  messagesForPatch,
} from "../utils/messages.js";
import { cloneEngineSessionForWorkflowRuntime } from "../session.js";
import { applyWorkflowInvalidation, applyWorkflowMessagePatch } from "./mutations.js";
import type { EngineEventSink, EngineSession, EngineTraceEvent, WorkflowEngineOptions } from "../types.js";
import { TurnChangeTracker } from "../utils/turn.js";
import { RuntimeTracer } from "./tracer.js";
import { WorkflowNodeRunner } from "./node-runner.js";
import { ResponseRenderer } from "./response-renderer.js";

export interface WorkflowTurnRunInput {
  instance: WorkflowInstance<JsonRecord>;
  session: EngineSession;
  message: WorkflowUserMessage;
  traces: EngineTraceEvent[];
  events: EngineEventSink;
  turnChanges: TurnChangeTracker;
  preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>;
  streamResponseDeltas: boolean;
}

export interface WorkflowTurnRunResult {
  workflowId: WorkflowId;
  description: string;
  response: RenderResponse;
  deltaMessages: WorkflowMessage[];
  sessionPatch?: SessionPatch | undefined;
}

/**
 * Runs one workflow instance through its full turn lifecycle.
 * Input: a routed runtime instance plus turn/session context from the engine.
 * Output: the workflow-owned response and runtime messages produced before render.
 * Boundary: this runner mutates only the supplied workflow instance and a cloned workflow-local session.
 */
export class WorkflowTurnRunner {
  constructor(
    private readonly deps: WorkflowEngineOptions["deps"],
    private readonly nodeRunner: WorkflowNodeRunner,
    private readonly renderer: ResponseRenderer,
    private readonly tracer: RuntimeTracer,
  ) {}

  /**
   * Executes beforePatch, withPatch, patch, afterPatch, and render for one instance.
   * Input: workflow-local turn input prepared by the engine.
   * Output: workflow response plus session patch metadata for engine-level merge.
   * Boundary: engine-level session transcript commit happens outside this method.
   */
  async run(input: WorkflowTurnRunInput): Promise<WorkflowTurnRunResult> {
    const { instance, session, message, traces, events, turnChanges, preStates, streamResponseDeltas } = input;
    const workflowMessagesBeforeTurn = copyWorkflowMessages(instance.state.messages);
    const workflowTurnMessages = [...workflowMessagesBeforeTurn, message];
    const messageText = message.content;
    const workflowSession = cloneEngineSessionForWorkflowRuntime(session, workflowTurnMessages);
    instance.state.messages = copyWorkflowMessages(workflowTurnMessages);
    this.tracer.trace(traces, {
      workflowId: instance.id,
      phase: "messages.user",
      detail: { contentChars: messageText.length },
    }, events);
    turnChanges.forWorkflow(instance.id).recordState(["messages"]);

    await this.nodeRunner.runStageOnce(
      instance,
      workflowSession,
      messageText,
      traces,
      events,
      turnChanges,
      preStates,
      "beforePatch",
    );
    await this.nodeRunner.runStageOnce(
      instance,
      workflowSession,
      messageText,
      traces,
      events,
      turnChanges,
      preStates,
      "withPatch",
    );

    const patch = await this.extractPatch(instance, traces, events);
    this.applyPatch(instance, workflowSession, patch, traces, events, turnChanges);

    await this.nodeRunner.runStageUntilStable(
      instance,
      workflowSession,
      messageText,
      traces,
      events,
      turnChanges,
      preStates,
      "afterPatch",
    );

    const { response } = await this.renderer.renderWorkflowResponse(
      instance,
      workflowSession,
      messageText,
      traces,
      events,
      turnChanges,
      preStates,
      streamResponseDeltas,
    );
    const deltaMessages = instance.state.messages.slice(workflowTurnMessages.length);
    appendWorkflowMessage(instance.state, assistantWorkflowMessage(response.text));

    return {
      workflowId: instance.id,
      description: instance.artifact.description,
      response,
      deltaMessages,
      ...(patch.sessionPatch === undefined ? {} : { sessionPatch: patch.sessionPatch }),
    };
  }

  private async extractPatch(
    instance: WorkflowInstance<JsonRecord>,
    traces: EngineTraceEvent[],
    events: EngineEventSink,
  ): Promise<MessagePatch> {
    const name = `${instance.id}_patch`;
    if (instance.artifact.patch.progress) {
      this.tracer.progress(traces, instance.id, {
        node: name,
        stage: "patch",
        progress: instance.artifact.patch.progress,
        description: "Extract structured workflow state from the latest user message.",
      }, events);
    }
    const startedAt = this.tracer.start(instance.id, "llm.patch", {
      name,
      model: instance.artifact.patch.model ?? "default",
    });

    try {
      const now = (this.deps.now?.() ?? new Date()).toISOString();
      const patch = await this.deps.llm.structured({
        name,
        ...(instance.artifact.patch.model ? { model: instance.artifact.patch.model } : {}),
        instruction: patchInstructionForRuntime(instance.artifact.patch.instruction, now, instance.state),
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

  private applyPatch(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    patch: MessagePatch,
    traces: EngineTraceEvent[],
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
  ): void {
    const dirtyFields = applyWorkflowMessagePatch(instance, session, patch, traces, events);
    const changes = turnChanges.forWorkflow(instance.id);
    changes.recordMessagePatchState(Object.keys(patch.statePatch ?? {}));
    const patchMessage = patchToolMessage(instance.id, patch);
    if (patchMessage) {
      appendWorkflowMessage(instance.state, patchMessage);
      this.tracer.trace(traces, {
        workflowId: instance.id,
        phase: "messages.patch",
        detail: { contentChars: safeJsonStringify(patchMessage.result).length },
      }, events);
      changes.recordState(["messages"]);
    }
    const invalidated = applyWorkflowInvalidation(instance, dirtyFields, traces, events);
    changes.recordState(dirtyFields);
    changes.recordInvalidatedState(invalidated);
  }
}

function assistantWorkflowMessage(content: string): WorkflowMessage {
  return { role: "assistant", content };
}

function patchToolMessage(workflowId: WorkflowId, patch: MessagePatch): WorkflowToolMessage | undefined {
  const result: JsonRecord = {};
  if (patch.sessionPatch !== undefined) result.sessionPatch = patch.sessionPatch;
  if (patch.statePatch !== undefined) result.statePatch = patch.statePatch;
  if (Object.keys(result).length === 0) return undefined;

  return {
    role: "tool",
    name: `${workflowId}.patch`,
    call: { stage: "patch", workflowId },
    result,
  };
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
