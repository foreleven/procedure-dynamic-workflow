import {
  type JsonRecord,
  type RenderPolicy,
  type RenderResponse,
  type WorkflowId,
  type WorkflowRuntimeState,
  type WorkflowStepController,
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
    private readonly renderOptions: WorkflowEngineOptions["render"],
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
    const merged = await this.renderMergedResponses(instances, session, message, traces, turnChanges);
    if (merged) return merged;

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
    this.recordAssistantMessage(instance, response, traces, turnChanges);
    return {
      workflowId: instance.id,
      response,
    };
  }

  /**
   * Renders multiple LLM render policies through one provider call when the
   * merge strategy allows it. Function renders stay separate because their
   * semantics are workflow-owned code rather than mergeable instructions.
   */
  private async renderMergedResponses(
    instances: RuntimeInstance[],
    session: EngineSession,
    message: string,
    traces: EngineTraceEvent[],
    turnChanges: TurnChangeTracker,
  ): Promise<Array<{ workflowId: WorkflowId; response: RenderResponse }> | undefined> {
    const participants = mergeableRenderParticipants(instances);
    if (!participants) return undefined;

    const decision = await this.renderOptions?.mergeStrategy?.({
      session,
      message,
      workflows: participants.map(({ instance, render }) => ({
        workflowId: instance.id,
        renderName: render.name,
      })),
    }) ?? "merge";
    if (decision === "separate") return undefined;

    const workflowIds = participants.map(({ instance }) => instance.id);
    const startedAt = this.tracer.start("engine", "render.merge", { workflowIds });
    for (const { instance, render } of participants) {
      this.tracer.progress(traces, instance.id, {
        node: render.name,
        stage: "render",
        progress: render.progress,
        description: "Merge this workflow render contract into one assistant reply.",
      });
    }

    const response = await this.renderMergedInstance(participants);
    const detail = { workflowIds, textChars: response.text.length };
    traces.push({
      workflowId: "engine",
      phase: "render.merge",
      detail,
    });
    this.tracer.done("engine", "render.merge", startedAt, detail);

    for (const { instance } of participants) {
      this.recordAssistantMessage(instance, response, traces, turnChanges);
    }

    return participants.map(({ instance }) => ({
      workflowId: instance.id,
      response,
    }));
  }

  private async renderMergedInstance(participants: MergeRenderParticipant[]): Promise<RenderResponse> {
    const workflowIds = participants.map(({ instance }) => instance.id);
    const primaryWorkflowId = workflowIds[0];
    if (!primaryWorkflowId) {
      return { text: "" };
    }

    const request = {
      name: "merged_render",
      instruction: mergedRenderInstructionForRuntime(participants),
      messages: participants.flatMap(({ instance }) => messagesForRender(instance.state)),
    };

    if (this.deps.llm.streamText) {
      let text = "";
      for await (const event of this.deps.llm.streamText(request)) {
        const normalizedEvent = normalizeStreamTextEvent(primaryWorkflowId, event);
        if (normalizedEvent.type === "text_delta") {
          text += normalizedEvent.delta;
          this.onResponseDelta?.({ workflowId: primaryWorkflowId, workflowIds, delta: normalizedEvent.delta });
          continue;
        }

        text = normalizedEvent.text;
      }

      return { text: text.trim() };
    }

    const text = renderText(primaryWorkflowId, await this.deps.llm.text(request), "llm.text");

    return { text: text.trim() };
  }

  private recordAssistantMessage(
    instance: RuntimeInstance,
    response: RenderResponse,
    traces: EngineTraceEvent[],
    turnChanges: TurnChangeTracker,
  ): void {
    if (appendWorkflowMessage(instance.state, { role: "assistant", content: response.text })) {
      traces.push({
        workflowId: instance.id,
        phase: "messages.assistant",
        detail: { contentChars: response.text.length },
      });
      turnChanges.forWorkflow(instance.id).recordState(["messages"]);
    }
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
  instance: RuntimeInstance;
  render: RenderPolicy;
}

function mergeableRenderParticipants(instances: RuntimeInstance[]): MergeRenderParticipant[] | undefined {
  if (instances.length <= 1) return undefined;

  const participants: MergeRenderParticipant[] = [];
  for (const instance of instances) {
    const render = instance.artifact.render;
    if (typeof render === "function") return undefined;
    participants.push({ instance, render });
  }

  return participants;
}

/**
 * Builds one render prompt for several workflow render policies.
 * Input: selected workflow instances after patch/nodes have run.
 * Output: a provider-facing instruction that preserves each workflow-owned
 * render contract while asking the model to produce one natural reply.
 * Boundary: this does not merge workflow state; it only exposes each state and
 * instruction to the LLM render call.
 */
function mergedRenderInstructionForRuntime(participants: MergeRenderParticipant[]): string {
  return [
    "PAC Render system prompt:",
    "You are the Render phase of a PAC workflow runtime. Several workflows matched the same user turn.",
    "",
    "Merged render responsibilities:",
    "- Compose exactly one natural assistant message for the user.",
    "- Cover every selected workflow's user-facing obligation without creating separate workflow sections unless sections are genuinely useful.",
    "- Reconcile overlap between workflows and avoid repeated introductions, repeated caveats, or contradictory framing.",
    "- Keep the response natural, concise, and appropriate for the user's language.",
    "",
    "Render prohibitions:",
    "- Do not advance or modify state; Patch and workflow nodes own state progression.",
    "- Do not call connectors, simulate connector calls, invent tool results, or invent unavailable options.",
    "- Do not invent or over-specify precise facts such as dates, prices, index points, percentages, volume, turnover, valuation, target prices, support/resistance levels, population, market size, rankings, ids, eligibility, or availability.",
    "- Only present a precise number or dated fact when it is visible in current state, runtime tool facts, or conversation history; otherwise use qualitative wording and state the data boundary.",
    "- When a precise number comes from a third-party report, news item, or analyst view, label it as a third-party estimate/view instead of presenting it as authoritative fact or advice.",
    "- Do not expose internal state fields, workflow ids, workflow labels, JSON, XML, DSML, or tool-call markup.",
    "",
    "Merged workflow render contracts:",
    ...participants.map(({ instance, render }, index) => [
      "",
      `Workflow ${index + 1}: ${instance.id}`,
      `Description: ${instance.artifact.description}`,
      `Render name: ${render.name}`,
      "Workflow-authored Render instruction:",
      render.instruction.trim(),
      "Current workflow state:",
      safeJsonStringify(stateForRender(instance.state), 2),
    ].join("\n")),
    "",
    "PAC merged render runtime contract:",
    "- The workflow states above are authoritative after the latest user turn, patch extraction, invalidation, and workflow nodes.",
    "- Provider-facing messages may include the same user turn once per workflow; treat repeated copies as the same user message.",
    "- Use runtime tool facts from any selected workflow as supporting facts, not as callable tools.",
    "- Render must only produce the next user-visible assistant message.",
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
