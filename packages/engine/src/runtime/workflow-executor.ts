/**
 * Parallel workflow execution coordinator.
 *
 * The executor only advances workflow runners to the render boundary. It yields
 * render handles in readiness order and never decides or executes response rendering.
 */
import { type WorkflowId } from "@pac/workflow";
import { type WorkflowTurnRender } from "./workflow-turn-runner.js";

export interface ExecutableWorkflowTurn {
  readonly workflowId: WorkflowId;
  execute(): Promise<WorkflowTurnRender>;
}

/**
 * Executes workflow runners concurrently and yields render handles as they become ready.
 * Input: executable workflow turn runners for one engine turn.
 * Output: async iterable ordered by render-boundary completion.
 * Boundary: this does not render, merge responses, emit assistant messages, or commit transcript.
 */
export class WorkflowExecutor {
  execute(
    runners: readonly ExecutableWorkflowTurn[],
  ): AsyncIterable<WorkflowTurnRender> {
    return this.iterateReadyRenders(runners);
  }

  private async *iterateReadyRenders(
    runners: readonly ExecutableWorkflowTurn[],
  ): AsyncIterable<WorkflowTurnRender> {
    const pending = new Map<WorkflowId, Promise<SettledWorkflowRender>>(
      runners.map((runner) => [runner.workflowId, settleWorkflowRender(
        runner.workflowId,
        runner.execute(),
      )]),
    );
    let firstError: unknown;

    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.workflowId);

      if (settled.status === "rejected") {
        firstError ??= settled.error;
        continue;
      }

      if (firstError === undefined) {
        yield settled.render;
      }
    }

    if (firstError !== undefined) throw firstError;
  }
}

type SettledWorkflowRender =
  | {
      readonly status: "fulfilled";
      readonly workflowId: WorkflowId;
      readonly render: WorkflowTurnRender;
    }
  | {
      readonly status: "rejected";
      readonly workflowId: WorkflowId;
      readonly error: unknown;
    };

async function settleWorkflowRender(
  workflowId: WorkflowId,
  promise: Promise<WorkflowTurnRender>,
): Promise<SettledWorkflowRender> {
  try {
    return {
      status: "fulfilled",
      workflowId,
      render: await promise,
    };
  } catch (error) {
    return {
      status: "rejected",
      workflowId,
      error,
    };
  }
}
