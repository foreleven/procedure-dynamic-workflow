/**
 * Workflow response rendering and engine-level response merge.
 *
 * This file converts completed workflow state/message history into either a
 * workflow-owned function render result or an LLM render request. It also merges
 * already-rendered workflow responses for presentation. It never advances state,
 * calls connectors, or commits session transcripts.
 */
import {
  type JsonRecord,
  type PrefetchStoreCheckpoint,
  type RenderPolicy,
  type RenderResponse,
  WorkflowContextStore,
  type WorkflowContextStoreCheckpoint,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowRuntimeState,
  type WorkflowStepController,
} from "@pac/workflow";
import type { EngineEventSink, EngineSession, WorkflowEngineOptions } from "../types.js";
import { RuntimeTracer } from "./tracer.js";
import { copyWorkflowMessages, messagesForRender } from "../utils/messages.js";
import { safeJsonStringify } from "../utils/json.js";
import { normalizeRenderResponse, normalizeStreamTextEvent, renderText } from "../utils/rendering.js";
import { TurnChangeTracker } from "../utils/turn.js";
import { cloneDefault } from "../patching.js";
import { cloneEngineSessionForExtension } from "../session.js";

/**
 * Renders workflow-local responses and merges completed engine responses.
 * Input: runtime dependencies, runtime tracer, and render options.
 * Output: normalized render responses and engine-level merged response text.
 * Boundary: WorkflowEngine owns turn scheduling and transcript commit.
 */
export class ResponseRenderer {
  constructor(
    private readonly deps: WorkflowEngineOptions["deps"],
    private readonly tracer: RuntimeTracer,
    private readonly renderOptions: WorkflowEngineOptions["render"],
  ) {}

  /**
   * Evaluates whether the engine should merge independently rendered workflow responses.
   * Input: selected instances before render, limited to render policies that expose mergeable metadata.
   * Output: merge or separate, preserving the historical default for mergeable LLM render policies.
   * Boundary: function-based renders remain separate because the engine cannot infer mergeable render contracts.
   */
  async mergeDecision(
    session: EngineSession,
    message: string,
    instances: readonly WorkflowInstance<JsonRecord>[],
  ): Promise<"merge" | "separate"> {
    const participants = mergeableRenderParticipants([...instances]);
    if (!participants) return "separate";
    return await this.renderOptions?.mergeStrategy?.({
      session,
      message,
      workflows: participants.map(({ instance, render }) => ({
        workflowId: instance.id,
        renderName: render.name,
      })),
    }) ?? "merge";
  }

  /**
   * Renders a single workflow instance response after that instance has completed its own patch and nodes.
   * Input: one runnable workflow instance and the current workflow-local turn state.
   * Output: the workflow id paired with its normalized response.
   * Boundary: this does not commit messages; the workflow runner and engine decide local/global message storage.
   */
  async renderWorkflowResponse(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    streamDeltas = true,
  ): Promise<{ workflowId: WorkflowId; response: RenderResponse }> {
    return this.renderAndRecordResponse(instance, session, events, turnChanges, streamDeltas);
  }

  /**
   * Merges already-rendered workflow responses into one user-visible engine response.
   * Input: independent workflow render responses from the same user turn.
   * Output: one normalized response suitable for the engine's merged assistant message.
   * Boundary: this is engine-level presentation only; workflow state and workflow-local responses are not changed.
   */
  async mergeRenderedResponses(
    participants: readonly MergedResponseParticipant[],
    session: EngineSession,
    message: string,
    events: EngineEventSink,
  ): Promise<RenderResponse> {
    const workflowIds = participants.map(({ workflowId }) => workflowId);
    if (participants.length === 0) return { text: "" };
    if (participants.length === 1) return participants[0]?.response ?? { text: "" };

    const request = {
      name: "merged_response",
      instruction: mergedResponseInstruction(participants, session, message),
      messages: [],
    };

    const mergedWorkflowId = mergedRenderWorkflowId(workflowIds);
    if (this.deps.llm.streamText) {
      let text = "";
      for await (const event of this.deps.llm.streamText(request)) {
        const normalizedEvent = normalizeStreamTextEvent(mergedWorkflowId, event);
        if (normalizedEvent.type === "text_delta") {
          text += normalizedEvent.delta;
          events.emit({
            event: {
              type: "assistant.message.delta",
              workflowId: mergedWorkflowId,
              workflowIds,
              delta: normalizedEvent.delta,
            },
          });
          continue;
        }

        text = normalizedEvent.text;
      }

      return { text: text.trim() };
    }

    const text = renderText(mergedWorkflowId, await this.deps.llm.text(request), "llm.text");
    return { text: text.trim() };
  }

  /**
   * Renders one workflow response and traces the assistant message selected for session commit.
   * Input: one runtime workflow instance plus the current session, event sink, and turn-change stores.
   * Output: the workflow id paired with its rendered response.
   * Boundary: this method does not mutate message history; WorkflowEngine commits messages after render.
   */
  private async renderAndRecordResponse(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
    streamDeltas = true,
  ): Promise<{ workflowId: WorkflowId; response: RenderResponse }> {
    const startedAt = this.tracer.start(instance.id, "render");
    const response = await this.renderInstance(instance, session, turnChanges, events, streamDeltas);
    this.tracer.done(instance.id, "render", startedAt, { textChars: response.text.length });
    this.traceAssistantMessage(instance, response, events, turnChanges);
    return {
      workflowId: instance.id,
      response,
    };
  }

  private traceAssistantMessage(
    instance: WorkflowInstance<JsonRecord>,
    response: RenderResponse,
    events: EngineEventSink,
    turnChanges: TurnChangeTracker,
  ): void {
    this.tracer.trace({
      workflowId: instance.id,
      phase: "messages.assistant",
      detail: { contentChars: response.text.length },
    }, events);
    turnChanges.forWorkflow(instance.id).recordState(["messages"]);
  }

  /**
   * Executes either workflow-owned render functions or LLM render policies.
   * Input: runtime instance, session, turn changes, and event sink.
   * Output: normalized render response.
   * Boundary: workflow-owned render functions may read runtime context but must return render data only.
   */
  private async renderInstance(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    turnChanges: TurnChangeTracker,
    events: EngineEventSink,
    streamDeltas: boolean,
  ): Promise<RenderResponse> {
    const render = instance.artifact.render;
    if (typeof render === "function") {
      const checkpoint = checkpointFunctionRenderRuntime(instance);
      try {
        const response = await render({
          session: cloneEngineSessionForExtension(session),
          context: instance.context,
          state: instance.state,
          prefetch: instance.prefetch,
          deps: this.deps,
          turn: turnChanges.snapshot(instance.id),
          step: noopStepController,
        });
        return normalizeRenderResponse(instance.id, response);
      } finally {
        restoreFunctionRenderRuntime(instance, checkpoint);
      }
    }

    const instruction = renderInstructionForRuntime(render.instruction, instance.state);
    this.tracer.progress(instance.id, {
      node: render.name,
      stage: "render",
      progress: render.progress,
      description: "Render the next assistant reply from the workflow message log.",
    }, events);

    const request = {
      name: render.name,
      instruction,
      messages: messagesForRender(instance.state),
    };

    if (this.deps.llm.streamText) {
      let text = "";
      for await (const event of this.deps.llm.streamText(request)) {
        const normalizedEvent = normalizeStreamTextEvent(instance.id, event);
        if (normalizedEvent.type === "text_delta") {
          text += normalizedEvent.delta;
          if (streamDeltas) {
            events.emit({
              event: {
                type: "assistant.message.delta",
                workflowId: instance.id,
                delta: normalizedEvent.delta,
              },
            });
          }
          continue;
        }

        text = normalizedEvent.text;
      }

      return { text: text.trim() };
    }

    const text = renderText(instance.id, await this.deps.llm.text(request), "llm.text");

    return { text: text.trim() };
  }
}

function mergedRenderWorkflowId(workflowIds: readonly WorkflowId[]): WorkflowId {
  return workflowIds.join("+");
}

const noopStepController: WorkflowStepController = {
  start(label) {
    return {
      id: "noop",
      label,
      child(childLabel) {
        return noopStepController.start(childLabel);
      },
      end() {
        return undefined;
      },
    };
  },
};

/**
 * Adds the authoritative workflow state to LLM render policy prompts.
 * Input: workflow-owned render instruction and runtime state after patch/nodes.
 * Output: provider-facing render instruction with state but without runtime message history.
 * Boundary: this only supplies facts to the renderer; it does not choose business branches in code.
 */
function renderInstructionForRuntime(instruction: string, state: JsonRecord): string {
  return [
    "PAC Render system prompt:",
    "You are the Render phase of a PAC workflow runtime. Your core job is user-facing reply expression and content output.",
    "",
    "Render responsibilities:",
    "- Compose exactly the next assistant message the user should see.",
    "- Use current workflow state as the authoritative source for what has been collected, selected, completed, or still missing.",
    "- Use conversation history and runtime tool facts as supporting context for names, labels, candidates, and previously shown choices.",
    "- Express the next useful step clearly: answer, ask for missing information, present choices, summarize results, or confirm completion according to the workflow instruction.",
    "- Keep the response natural, concise, and appropriate for the user's language and the workflow context.",
    "",
    "Render prohibitions:",
    "- Do not advance or modify state; Patch and workflow nodes own state progression.",
    "- Do not call connectors, simulate connector calls, invent tool results, or invent unavailable options.",
    "- Do not invent or over-specify precise facts such as dates, prices, index points, percentages, volume, turnover, valuation, target prices, support/resistance levels, population, market size, rankings, ids, eligibility, or availability.",
    "- Only present a precise number or dated fact when it is visible in current state, runtime tool facts, or conversation history; otherwise use qualitative wording and state the data boundary.",
    "- When a precise number comes from a third-party report, news item, or analyst view, label it as a third-party estimate/view instead of presenting it as authoritative fact or advice.",
    "- Do not expose internal state fields, workflow labels, JSON, XML, DSML, or tool-call markup.",
    "",
    "Workflow-authored Render instructions:",
    instruction.trim(),
    "",
    "PAC Render runtime contract:",
    "- The current workflow state below is authoritative after the latest user turn, patch extraction, invalidation, and workflow nodes.",
    "- Use the state to decide which facts are already collected. A null field means that fact is not collected.",
    "- Render must only produce the next user-visible assistant message.",
    "- No connector tools are available during render; never emit tool-call markup, JSON, internal state names, or workflow labels.",
    "",
    "Current workflow state:",
    safeJsonStringify(stateForRender(state), 2),
  ].join("\n");
}

interface MergeRenderParticipant {
  instance: WorkflowInstance<JsonRecord>;
  render: RenderPolicy;
}

function mergeableRenderParticipants(instances: WorkflowInstance<JsonRecord>[]): MergeRenderParticipant[] | undefined {
  if (instances.length <= 1) return undefined;

  const participants: MergeRenderParticipant[] = [];
  for (const instance of instances) {
    const render = instance.artifact.render;
    if (typeof render === "function") return undefined;
    participants.push({ instance, render });
  }

  return participants;
}

export interface MergedResponseParticipant {
  workflowId: WorkflowId;
  description: string;
  response: RenderResponse;
}

interface FunctionRenderRuntimeCheckpoint {
  readonly state: WorkflowRuntimeState<JsonRecord>;
  readonly context: WorkflowContextStoreCheckpoint;
  readonly prefetch: PrefetchStoreCheckpoint;
}

function checkpointFunctionRenderRuntime(
  instance: WorkflowInstance<JsonRecord>,
): FunctionRenderRuntimeCheckpoint {
  return {
    state: cloneRuntimeState(instance.state),
    context: contextStoreFor(instance).checkpoint(),
    prefetch: instance.prefetch.checkpoint(),
  };
}

function restoreFunctionRenderRuntime(
  instance: WorkflowInstance<JsonRecord>,
  checkpoint: FunctionRenderRuntimeCheckpoint,
): void {
  instance.state = cloneRuntimeState(checkpoint.state);
  contextStoreFor(instance).restore(checkpoint.context);
  instance.prefetch.restore(checkpoint.prefetch);
}

function contextStoreFor(instance: WorkflowInstance<JsonRecord>): WorkflowContextStore {
  if (instance.context instanceof WorkflowContextStore) {
    return instance.context;
  }

  throw new Error(`Workflow ${instance.id} runtime context store does not support render checkpoint restore`);
}

function cloneRuntimeState(
  state: WorkflowRuntimeState<JsonRecord>,
): WorkflowRuntimeState<JsonRecord> {
  try {
    return cloneDefault(state);
  } catch {
    const { messages, ...fields } = state;
    return {
      ...fields,
      messages: copyWorkflowMessages(messages),
    };
  }
}

function mergedResponseInstruction(
  participants: readonly MergedResponseParticipant[],
  session: EngineSession,
  message: string,
): string {
  return [
    "PAC Engine response merge prompt:",
    "Several workflow instances independently completed the same user turn and produced final workflow responses.",
    "",
    "Merge responsibilities:",
    "- Compose exactly one natural assistant message for the user.",
    "- Preserve every workflow response's user-facing obligation.",
    "- Remove duplicated greetings, repeated caveats, and contradictory framing.",
    "- Keep the response concise and appropriate for the user's language.",
    "",
    "Merge prohibitions:",
    "- Do not modify workflow state or claim additional workflow actions happened.",
    "- Do not call connectors, simulate connector calls, or invent unavailable facts.",
    "- Do not expose workflow ids, internal state fields, JSON, XML, DSML, or tool-call markup.",
    "",
    `Latest user message: ${message}`,
    `Session id: ${session.sessionId}`,
    "",
    "Workflow responses:",
    ...participants.map(({ workflowId, description, response }, index) => [
      "",
      `Workflow ${index + 1}: ${workflowId}`,
      `Description: ${description}`,
      "Response:",
      response.text,
    ].join("\n")),
  ].join("\n");
}

function stateForRender(state: JsonRecord): JsonRecord {
  const snapshot: JsonRecord = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === "messages") continue;
    snapshot[key] = value;
  }
  return snapshot;
}
