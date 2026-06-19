/**
 * Workflow render presentation coordinator.
 *
 * This layer consumes render handles produced by WorkflowExecutor and decides
 * whether to execute each render separately or merge completed workflow responses
 * into one user-visible response. It does not run workflow nodes or commit session
 * transcript state.
 */
import {
  type JsonRecord,
  type RenderResponse,
  type WorkflowId,
  type WorkflowInstance,
  type WorkflowMessage,
} from "@pac/workflow";
import { cloneEngineSessionForExtension } from "../session.js";
import type { EngineEventSink, EngineSession } from "../types.js";
import { ResponseRenderer, type MergedResponseParticipant } from "./response-renderer.js";
import { RuntimeTracer } from "./tracer.js";
import { type WorkflowTurnRender, type WorkflowTurnRunResult } from "./workflow-turn-runner.js";

export type WorkflowResponseMode = "merge" | "separate";

export interface WorkflowRendererInput {
  readonly renders: AsyncIterable<WorkflowTurnRender>;
  readonly instances: readonly WorkflowInstance<JsonRecord>[];
  readonly session: EngineSession;
  readonly message: string;
  readonly events: EngineEventSink;
}

export interface WorkflowRenderOutput {
  readonly workflowResults: WorkflowTurnRunResult[];
  readonly responseMode: WorkflowResponseMode;
  readonly outputMessages: WorkflowMessage[];
}

/**
 * Executes workflow render handles according to engine presentation policy.
 * Input: render handles in readiness order plus the selected workflow instances.
 * Output: workflow results and assistant messages ready for session commit.
 * Boundary: this does not mutate engine session; WorkflowEngine owns transcript commit.
 */
export class WorkflowRenderer {
  constructor(
    private readonly responseRenderer: ResponseRenderer,
    private readonly tracer: RuntimeTracer,
  ) {}

  async render(input: WorkflowRendererInput): Promise<WorkflowRenderOutput> {
    const responseMode = await this.responseMode(input.instances, input.session, input.message);
    if (responseMode === "merge") {
      return await this.renderMerged(input);
    }

    return await this.renderSeparate(input);
  }

  private async responseMode(
    instances: readonly WorkflowInstance<JsonRecord>[],
    session: EngineSession,
    message: string,
  ): Promise<WorkflowResponseMode> {
    if (instances.length <= 1) return "separate";
    return await this.responseRenderer.mergeDecision(
      cloneEngineSessionForExtension(session),
      message,
      instances,
    );
  }

  private async renderSeparate(input: WorkflowRendererInput): Promise<WorkflowRenderOutput> {
    const results: WorkflowTurnRunResult[] = [];
    const includeWorkflowId = input.instances.length > 1;
    const iterator = input.renders[Symbol.asyncIterator]();
    const pending = new Map<WorkflowId, Promise<SeparateRenderStep>>();
    let nextRender: Promise<SeparateRenderStep> | undefined = settleNextRender(iterator.next());
    let firstError: unknown;

    while (nextRender !== undefined || pending.size > 0) {
      const raceCandidates = [
        ...(nextRender === undefined ? [] : [nextRender]),
        ...pending.values(),
      ];
      const settled = await Promise.race(raceCandidates);

      if (settled.type === "render_source") {
        if (settled.result.done) {
          nextRender = undefined;
          continue;
        }

        const render = settled.result.value;
        pending.set(render.workflowId, settleSeparateRender(render, true));
        nextRender = settleNextRender(iterator.next());
        continue;
      }

      if (settled.type === "render_source_rejected") {
        firstError ??= settled.error;
        nextRender = undefined;
        continue;
      }

      pending.delete(settled.workflowId);
      if (settled.type === "render_rejected") {
        firstError ??= settled.error;
        continue;
      }

      if (firstError === undefined) {
        results.push(settled.result);
        input.events.emit({
          message: assistantWorkflowMessage(
            settled.result.response.text,
            includeWorkflowId ? settled.result.workflowId : undefined,
          ),
        });
      }
    }

    if (firstError !== undefined) throw firstError;

    return {
      workflowResults: results,
      responseMode: "separate",
      outputMessages: results.map((result) => assistantWorkflowMessage(
        result.response.text,
        includeWorkflowId ? result.workflowId : undefined,
      )),
    };
  }

  private async renderMerged(input: WorkflowRendererInput): Promise<WorkflowRenderOutput> {
    const order = workflowOrder(input.instances);
    const renderExecutions: OrderedRenderExecution[] = [];
    let sourceError: unknown;

    try {
      for await (const render of input.renders) {
        renderExecutions.push({
          order: order.get(render.workflowId) ?? renderExecutions.length,
          workflowId: render.workflowId,
          promise: render.execute({ streamResponseDeltas: false }),
        });
      }
    } catch (error) {
      sourceError = error;
    }

    const workflowResults = await settleOrderedRenderExecutions(renderExecutions);
    if (sourceError !== undefined) throw sourceError;

    const finalResponse = await this.finalResponseForWorkflowResults(
      workflowResults,
      input.session,
      input.message,
      input.events,
    );
    const outputMessages = [assistantWorkflowMessage(finalResponse.text)];
    for (const outputMessage of outputMessages) {
      input.events.emit({ message: outputMessage });
    }

    return {
      workflowResults,
      responseMode: "merge",
      outputMessages,
    };
  }

  private async finalResponseForWorkflowResults(
    workflowResults: readonly WorkflowTurnRunResult[],
    session: EngineSession,
    message: string,
    events: EngineEventSink,
  ): Promise<RenderResponse> {
    const primaryResponse = workflowResults[0]?.response ?? { text: "" };
    if (workflowResults.length <= 1) {
      return primaryResponse;
    }

    const participants: MergedResponseParticipant[] = workflowResults.map((result) => ({
      workflowId: result.workflowId,
      description: result.description,
      response: result.response,
    }));
    const workflowIds = participants.map(({ workflowId }) => workflowId);
    const startedAt = this.tracer.start("engine", "response.merge", { workflowIds });
    const response = await this.responseRenderer.mergeRenderedResponses(participants, session, message, events);
    const detail = { workflowIds, textChars: response.text.length };
    this.tracer.trace({
      workflowId: "engine",
      phase: "response.merge",
      detail,
    }, events);
    this.tracer.done("engine", "response.merge", startedAt, detail);
    return response;
  }
}

interface OrderedRenderExecution {
  readonly order: number;
  readonly workflowId: WorkflowId;
  readonly promise: Promise<WorkflowTurnRunResult>;
}

type SeparateRenderStep =
  | {
      readonly type: "render_source";
      readonly result: IteratorResult<WorkflowTurnRender>;
    }
  | {
      readonly type: "render_source_rejected";
      readonly error: unknown;
    }
  | {
      readonly type: "render_fulfilled";
      readonly workflowId: WorkflowId;
      readonly result: WorkflowTurnRunResult;
    }
  | {
      readonly type: "render_rejected";
      readonly workflowId: WorkflowId;
      readonly error: unknown;
    };

type SettledOrderedRenderExecution =
  | {
      readonly status: "fulfilled";
      readonly order: number;
      readonly result: WorkflowTurnRunResult;
    }
  | {
      readonly status: "rejected";
      readonly order: number;
      readonly error: unknown;
    };

function workflowOrder(instances: readonly WorkflowInstance<JsonRecord>[]): Map<WorkflowId, number> {
  return new Map(instances.map((instance, index) => [instance.id, index]));
}

async function settleNextRender(
  promise: Promise<IteratorResult<WorkflowTurnRender>>,
): Promise<SeparateRenderStep> {
  try {
    return {
      type: "render_source",
      result: await promise,
    };
  } catch (error) {
    return {
      type: "render_source_rejected",
      error,
    };
  }
}

async function settleSeparateRender(
  render: WorkflowTurnRender,
  streamResponseDeltas: boolean,
): Promise<SeparateRenderStep> {
  try {
    return {
      type: "render_fulfilled",
      workflowId: render.workflowId,
      result: await render.execute({ streamResponseDeltas }),
    };
  } catch (error) {
    return {
      type: "render_rejected",
      workflowId: render.workflowId,
      error,
    };
  }
}

async function settleOrderedRenderExecutions(
  executions: readonly OrderedRenderExecution[],
): Promise<WorkflowTurnRunResult[]> {
  const settled = await Promise.all(executions.map(settleOrderedRenderExecution));
  const firstError = settled.find((item) => item.status === "rejected");
  if (firstError) throw firstError.error;

  return settled
    .map((item) => {
      if (item.status === "rejected") throw item.error;
      return item;
    })
    .sort((left, right) => left.order - right.order)
    .map((item) => item.result);
}

async function settleOrderedRenderExecution(
  execution: OrderedRenderExecution,
): Promise<SettledOrderedRenderExecution> {
  try {
    return {
      status: "fulfilled",
      order: execution.order,
      result: await execution.promise,
    };
  } catch (error) {
    return {
      status: "rejected",
      order: execution.order,
      error,
    };
  }
}

function assistantWorkflowMessage(content: string, workflowId?: WorkflowId): WorkflowMessage {
  return workflowId === undefined
    ? { role: "assistant", content }
    : { role: "assistant", content, workflowId };
}
