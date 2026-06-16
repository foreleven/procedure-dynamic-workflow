import {
  type JsonRecord,
  type RenderPolicy,
  type RenderResponse,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowRuntimeState,
  type WorkflowStepController,
} from "@pac/workflow";
import type { EngineSession, EngineTraceEvent, WorkflowEngineOptions } from "../types.js";
import { RuntimeTracer } from "./tracer.js";
import { messagesForRender } from "../utils/messages.js";
import { safeJsonStringify } from "../utils/json.js";
import { normalizeRenderResponse, normalizeStreamTextEvent, renderText } from "../utils/rendering.js";
import { preStateFor } from "../utils/state.js";
import { TurnChangeTracker } from "../utils/turn.js";

/**
 * Renders workflow-local responses and merges completed engine responses.
 * Input: runtime dependencies, runtime tracer, and optional stream delta callback.
 * Output: normalized render responses and engine-level merged response text.
 * Boundary: WorkflowEngine owns turn scheduling and transcript commit.
 */
export class ResponseRenderer {
  constructor(
    private readonly deps: WorkflowEngineOptions["deps"],
    private readonly tracer: RuntimeTracer,
    private readonly onResponseDelta: WorkflowEngineOptions["onResponseDelta"],
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
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    streamDeltas = true,
  ): Promise<{ workflowId: WorkflowId; response: RenderResponse }> {
    return this.renderAndRecordResponse(instance, session, message, traces, turnChanges, preStates, streamDeltas);
  }

  /**
   * Merges already-rendered workflow responses into one user-visible engine response.
   * Input: independent workflow render responses from the same user turn.
   * Output: one normalized response suitable for `EngineTurnResult.response`.
   * Boundary: this is engine-level presentation only; workflow state and workflow-local responses are not changed.
   */
  async mergeRenderedResponses(
    participants: readonly MergedResponseParticipant[],
    session: EngineSession,
    message: string,
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
          this.onResponseDelta?.({ workflowId: mergedWorkflowId, workflowIds, delta: normalizedEvent.delta });
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
   * Input: one runtime workflow instance plus the current session, message, traces, and turn-change stores.
   * Output: the workflow id paired with its rendered response.
   * Boundary: this method does not mutate message history; WorkflowEngine commits messages after render.
   */
  private async renderAndRecordResponse(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    streamDeltas = true,
  ): Promise<{ workflowId: WorkflowId; response: RenderResponse }> {
    const startedAt = this.tracer.start(instance.id, "render");
    const response = await this.renderInstance(instance, session, message, turnChanges, preStates, traces, streamDeltas);
    this.tracer.done(instance.id, "render", startedAt, { textChars: response.text.length });
    this.traceAssistantMessage(instance, response, traces, turnChanges);
    return {
      workflowId: instance.id,
      response,
    };
  }

  private traceAssistantMessage(
    instance: WorkflowInstance<JsonRecord>,
    response: RenderResponse,
    traces: EngineTraceEvent[],
    turnChanges: TurnChangeTracker,
  ): void {
    traces.push({
      workflowId: instance.id,
      phase: "messages.assistant",
      detail: { contentChars: response.text.length },
    });
    turnChanges.forWorkflow(instance.id).recordState(["messages"]);
  }

  /**
   * Executes either workflow-owned render functions or LLM render policies.
   * Input: runtime instance, session, message, turn changes, pre-turn state, and trace store.
   * Output: normalized render response.
   * Boundary: workflow-owned render functions may read runtime context but must return render data only.
   */
  private async renderInstance(
    instance: WorkflowInstance<JsonRecord>,
    session: EngineSession,
    message: string,
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
    traces: EngineTraceEvent[],
    streamDeltas: boolean,
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
        step: noopStepController,
        message,
      });
      return normalizeRenderResponse(instance.id, response);
    }

    const instruction = renderInstructionForRuntime(render.instruction, instance.state);
    this.tracer.progress(traces, instance.id, {
      node: render.name,
      stage: "render",
      progress: render.progress,
      description: "Render the next assistant reply from the workflow message log.",
    });

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
            this.onResponseDelta?.({ workflowId: instance.id, delta: normalizedEvent.delta });
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
