import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowExecutor, type ExecutableWorkflowTurn } from "./workflow-executor.js";

test("WorkflowExecutor yields render handles by readiness and does not execute render", async () => {
  const executor = new WorkflowExecutor();
  const yielded: string[] = [];
  let renderExecuted = false;
  const runners = [
    delayedRunner("slow", 12, () => {
      renderExecuted = true;
    }),
    delayedRunner("fast", 1, () => {
      renderExecuted = true;
    }),
  ];

  for await (const render of executor.execute(runners)) {
    yielded.push(render.workflowId);
  }

  assert.deepEqual(yielded, ["fast", "slow"]);
  assert.equal(renderExecuted, false);
});

function delayedRunner(
  workflowId: string,
  delayMs: number,
  markRenderExecuted: () => void,
): ExecutableWorkflowTurn {
  return {
    workflowId,
    async execute() {
      await delay(delayMs);
      return {
        workflowId,
        description: `${workflowId} render handle`,
        async execute() {
          markRenderExecuted();
          return {
            workflowId,
            description: `${workflowId} result`,
            response: { text: workflowId },
            deltaMessages: [],
          };
        },
      };
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
