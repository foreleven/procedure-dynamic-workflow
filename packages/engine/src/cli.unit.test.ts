import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLogger,
  parseArgs,
  usageText,
} from "./cli/support.js";
import {
  loadWorkflow,
  loadWorkflows,
} from "./cli/module-loader.js";

test("CLI usage documents the required workflow flag and environment variables", () => {
  const usage = usageText();

  assert.match(usage, /Usage:/);
  assert.match(usage, /--workflow <workflow-file>/);
  assert.match(usage, /OPENAI_API_KEY/);
});

test("parseArgs requires a workflow path before runtime startup", () => {
  assert.throws(() => parseArgs([]), /Missing required --workflow <path>/);
});

test("parseArgs rejects missing values for file and configuration flags", () => {
  assert.throws(() => parseArgs(["--workflow", "--debug"]), /Missing value for --workflow/);
  assert.throws(() => parseArgs(["--workflow", "flow.ts", "--connectors"]), /Missing value for --connectors/);
  assert.throws(() => parseArgs(["--workflow", "flow.ts", "--model"]), /Missing value for --model/);
});

test("parseArgs accepts flag-like message payloads without consuming configuration flags", () => {
  const options = parseArgs(["--workflow", "flow.ts", "--message", "--not-a-flag"]);

  assert.equal(options.workflowPath, "flow.ts");
  assert.deepEqual(options.messages, ["--not-a-flag"]);
});

test("createLogger prints node step loading events in non-debug mode", () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    output.push(String(value));
  };

  try {
    const logger = createLogger(false);
    logger('[engine] flow node.step.start event {"label":"Load connector"}');
    logger('[engine] flow node.step.end event {"label":"Load connector","status":"done","durationMs":12}');
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output, [
    "  - Load connector ...",
    "  - Load connector done (12ms)",
  ]);
});

test("loadWorkflows accepts workflow array exports and loadWorkflow rejects them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pac-engine-loader-"));
  const modulePath = join(dir, "multi-workflow.mjs");

  await writeFile(
    modulePath,
    `
const parser = {
  parse(input) {
    return input;
  },
};

function createWorkflow(id) {
  return {
    id,
    version: "0.1.0",
    description: "Loader fixture workflow.",
    routing: {
      examples: ["fixture"],
      entities: ["fixture"],
      neighbors: [],
      thresholds: {
        localAccept: 0.1,
        localUncertain: 0.05,
        globalAccept: 0.1,
      },
    },
    stateSchema: parser,
    state: {},
    nodes: [{
      kind: "effect",
      name: "noop",
      stage: "afterPatch",
      description: "No-op effect fixture.",
      run: () => undefined,
    }],
    patch: {
      schema: parser,
      instruction: "Extract no fixture state.",
    },
    invalidation: {},
    render: () => ({ text: "ok" }),
  };
}

export const workflows = [
  createWorkflow("flow_a"),
  createWorkflow("flow_b"),
];
`,
  );

  try {
    const workflows = await loadWorkflows(modulePath);

    assert.deepEqual(workflows.map((workflow) => workflow.id), ["flow_a", "flow_b"]);
    await assert.rejects(
      () => loadWorkflow(modulePath),
      /Module must export exactly one workflow definition/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
