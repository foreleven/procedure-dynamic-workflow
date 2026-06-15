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
  loadConnectorFiles,
  loadWorkflowFiles,
  loadWorkflow,
  loadWorkflows,
} from "./cli/module-loader.js";
import { resolveCliWorkflowSource } from "./cli/agent-manifest.js";

test("CLI usage documents agent path defaults and environment variables", () => {
  const usage = usageText();

  assert.match(usage, /Usage:/);
  assert.match(usage, /\[agent-dir-or-agent\.yaml-or-workflow-file\]/);
  assert.match(usage, /loads agent\.yaml from the current directory/);
  assert.match(usage, /--case <id>/);
  assert.match(usage, /OPENAI_API_KEY/);
});

test("parseArgs defaults to current directory when no workflow path is supplied", () => {
  const options = parseArgs([]);

  assert.equal(options.workflowPath, ".");
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

test("parseArgs accepts agent case execution flags", () => {
  const options = parseArgs([
    "agents/maintenance",
    "--case",
    "case_a",
    "--case",
    "case_b",
    "--all-cases",
  ]);

  assert.equal(options.workflowPath, "agents/maintenance");
  assert.deepEqual(options.caseIds, ["case_a", "case_b"]);
  assert.equal(options.runAllCases, true);
});

test("resolveCliWorkflowSource loads agent.yaml from an agent directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pac-engine-agent-"));

  await writeFile(
    join(dir, "agent.yaml"),
    `
connectors:
  - main
workflows:
  flow_a:
    id: flow_a
    version: 0.1.0
    description: Agent fixture.
    routing:
      examples: [fixture]
      entities: [fixture]
cases:
  - id: case_a
    description: Fixture case.
    userId: user_a
    turns:
      - message: hello
        expect:
          responseSatisfies: replies
`,
  );

  try {
    const source = resolveCliWorkflowSource(dir);

    assert.equal(source.kind, "agent");
    if (source.kind !== "agent") return;

    assert.deepEqual(source.workflowFiles, [{
      name: "flow_a",
      id: "flow_a",
      path: join(dir, "workflows", "flow_a.workflow.ts"),
    }]);
    assert.deepEqual(source.connectorFiles, [{
      name: "main",
      path: join(dir, "connectors", "main.ts"),
    }]);
    assert.deepEqual(source.manifest.workflowIds, ["flow_a"]);
    assert.equal(source.manifest.cases[0]?.id, "case_a");
    assert.equal(source.manifest.cases[0]?.turns[0]?.message, "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadWorkflowFiles requires one workflow definition per manifest-derived file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pac-engine-loader-files-"));
  const modulePath = join(dir, "flow.mjs");

  await writeFile(
    modulePath,
    `
const parser = {
  parse(input) {
    return input;
  },
};

export default {
  id: "flow_a",
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
`,
  );

  try {
    const workflows = await loadWorkflowFiles([modulePath]);

    assert.deepEqual(workflows.map((workflow) => workflow.id), ["flow_a"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConnectorFiles creates a registry from connector loader functions", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".tmp", "pac-engine-connectors-"));
  const modulePath = join(dir, "main.mjs");

  await writeFile(
    modulePath,
    `
import { z } from "zod";

export default function loadConnectorTools() {
  return [{
    id: "fixture.echo",
    description: "Echo fixture connector.",
    inputSchema: z.object({ ok: z.boolean() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute(input) {
      return input;
    },
  }];
}
`,
  );

  try {
    const registry = await loadConnectorFiles([modulePath]);

    assert.equal(registry.has("fixture.echo"), true);
    assert.deepEqual(await registry.call("fixture.echo", { ok: true }), { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
