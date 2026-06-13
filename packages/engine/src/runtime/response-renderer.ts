import {
  type JsonRecord,
  type RenderResponse,
  type WorkflowId,
  type WorkflowRuntimeState,
} from "@pac/workflow";
import type { EngineSession, EngineTraceEvent, RuntimeInstance, WorkflowEngineOptions } from "../types.js";
import { RuntimeTracer } from "./tracer.js";
import { appendWorkflowMessage, messagesForRender } from "../utils/messages.js";
import { safeJsonStringify } from "../utils/json.js";
import { normalizeRenderResponse, normalizeStreamTextEvent, renderText } from "../utils/rendering.js";
import { preStateFor } from "../utils/state.js";
import { TurnChangeTracker } from "../utils/turn.js";

/**
 * Renders workflow responses and records assistant messages in runtime state.
 * Input: runtime dependencies, runtime tracer, and optional stream delta callback.
 * Output: per-workflow render responses with assistant message side effects applied.
 * Boundary: WorkflowEngine owns turn scheduling; this class owns only response rendering and render traces.
 */
export class ResponseRenderer {
  constructor(
    private readonly deps: WorkflowEngineOptions["deps"],
    private readonly tracer: RuntimeTracer,
    private readonly onResponseDelta: WorkflowEngineOptions["onResponseDelta"],
  ) {}

  /**
   * Renders all runnable workflows in the order required by streaming behavior.
   * Input: runnable instances plus current turn/session state.
   * Output: rendered responses paired with workflow ids.
   * Boundary: streaming mode renders sequentially so deltas stay ordered; non-streaming mode renders concurrently.
   */
  async renderResponses(
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
      instances.map(async (instance) =>
        this.renderAndRecordResponse(instance, session, message, traces, turnChanges, preStates),
      ),
    );
  }

  /**
   * Renders one workflow response and records the assistant message in that workflow's runtime state.
   * Input: one runtime workflow instance plus the current session, message, traces, and turn-change stores.
   * Output: the workflow id paired with its rendered response.
   * Boundary: appending assistant messages is the only state mutation this method performs.
   */
  private async renderAndRecordResponse(
    instance: RuntimeInstance,
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: TurnChangeTracker,
    preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
  ): Promise<{ workflowId: WorkflowId; response: RenderResponse }> {
    const startedAt = this.tracer.start(instance.id, "render");
    const response = await this.renderInstance(instance, session, message, turnChanges, preStates, traces);
    this.tracer.done(instance.id, "render", startedAt, { textChars: response.text.length });
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

  /**
   * Executes either workflow-owned render functions or LLM render policies.
   * Input: runtime instance, session, message, turn changes, pre-turn state, and trace store.
   * Output: normalized render response.
   * Boundary: workflow-owned render functions may read runtime context but must return render data only.
   */
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
}

/**
 * Adds the authoritative workflow state to LLM render policy prompts.
 * Input: workflow-owned render instruction and runtime state after patch/nodes.
 * Output: provider-facing render instruction with state but without runtime message history.
 * Boundary: this only supplies facts to the renderer; it does not choose business branches in code.
 */
function renderInstructionForRuntime(instruction: string, state: JsonRecord): string {
  return [
    instruction.trim(),
    "",
    "Runtime render contract:",
    "- The current workflow state below is authoritative after the latest user turn, patch extraction, invalidation, and workflow nodes.",
    "- Use the state to decide which facts are already collected. A null field means that fact is not collected.",
    "- Render must only produce the next user-visible assistant message.",
    "- No connector tools are available during render; never emit tool-call markup, JSON, internal state names, or workflow labels.",
    "",
    "Current workflow state:",
    safeJsonStringify(stateForRender(state), 2),
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
