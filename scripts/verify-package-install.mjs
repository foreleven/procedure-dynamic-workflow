import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempRoot = resolve(".tmp/package-install");
const packDir = resolve(tempRoot, "packs");
const appDir = resolve(tempRoot, "app");

rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(appDir, { recursive: true });

try {
  const workflowTarball = await packWorkspace("@pac/workflow");
  const engineTarball = await packWorkspace("@pac/engine");

  writeFileSync(
    resolve(appDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@pac/workflow": `file:${workflowTarball}`,
          "@pac/engine": `file:${engineTarball}`,
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(resolve(appDir, "runtime.mjs"), runtimeSource());
  writeFileSync(resolve(appDir, "consumer.ts"), consumerSource());
  writeFileSync(
    resolve(appDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ),
  );

  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: appDir,
    maxBuffer: 1024 * 1024 * 10,
  });
  await execFileAsync("node", [resolve(appDir, "runtime.mjs")], {
    cwd: appDir,
    maxBuffer: 1024 * 1024 * 10,
  });
  await execFileAsync("npx", ["tsc", "-p", resolve(appDir, "tsconfig.json"), "--noEmit"], {
    cwd: appDir,
    maxBuffer: 1024 * 1024 * 10,
  });

  console.log("ok package install: tarballs install, import, and type-check externally");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

/**
 * Packs one workspace into the temporary package directory.
 * Input: workspace name accepted by npm pack --workspace.
 * Output: absolute path to the generated tarball.
 * Boundary: npm's prepack script owns rebuilding package artifacts.
 */
async function packWorkspace(workspace) {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--workspace", workspace, "--pack-destination", packDir, "--json"],
    { maxBuffer: 1024 * 1024 * 10 },
  );
  const [pack] = parseNpmPackJson(stdout);
  if (!pack?.filename) {
    throw new Error(`Unexpected npm pack output for ${workspace}`);
  }
  return resolve(packDir, pack.filename);
}

function parseNpmPackJson(stdout) {
  const start = stdout.lastIndexOf("\n[");
  const jsonStart = start >= 0 ? start + 1 : stdout.indexOf("[");
  if (jsonStart < 0) {
    throw new Error(`npm pack did not emit JSON:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

/**
 * Runtime import smoke for installed tarballs.
 * Input: none.
 * Output: JavaScript source that imports installed packages by package name.
 * Boundary: this avoids real LLM calls and only constructs a local engine/session.
 */
function runtimeSource() {
  return `
import { createConnectorRegistry, definePatch, defineRouting, z } from "@pac/workflow";
import { WorkflowEngine } from "@pac/engine";

const workflow = {
  id: "installed_flow",
  version: "0.1.0",
  description: "Installed tarball runtime smoke workflow.",
  routing: defineRouting({
    examples: ["installed flow"],
    entities: ["installed"],
    neighbors: [],
  }),
  stateSchema: z.object({ ready: z.boolean() }),
  state: { ready: false },
  patch: definePatch({ state: { ready: z.boolean() } }),
  invalidation: {},
  nodes: [
    {
      kind: "effect",
      name: "mark_ready",
      stage: "afterPatch",
      progress: "Marking ready",
      description: "Marks installed package smoke workflow ready.",
      run: () => ({ state: { ready: true } }),
    },
  ],
  render: ({ state }) => ({ text: state.ready ? "ready" : "not ready" }),
};

const llm = {
  async text() {
    return "ok";
  },
  async structured(request) {
    return request.schema.parse({ statePatch: {} });
  },
};

const engine = new WorkflowEngine({
  workflows: [workflow],
  deps: {
    connectors: createConnectorRegistry(),
    llm,
  },
});

const session = engine.createSession({
  sessionId: "installed_session",
  userId: "installed_user",
  activeWorkflowIds: [workflow.id],
});
const result = await engine.onMessage("run", session);
if (result.response.text !== "ready") {
  throw new Error("installed tarball runtime smoke returned unexpected response");
}
`;
}

/**
 * Declaration smoke for installed tarballs.
 * Input: none.
 * Output: TypeScript source compiled from the temporary app's node_modules.
 * Boundary: this covers declaration files after npm install, not repo path aliases.
 */
function consumerSource() {
  return `
import {
  createConnectorRegistry,
  defineConnectorRef,
  defineConnectorTool,
  definePatch,
  defineRouting,
  type RenderResponse,
  type WorkflowPatch,
  type WorkflowDefinition,
  workflowActions,
  z,
} from "@pac/workflow";
import {
  WorkflowEngine,
  createLlmClient,
  type CreateSessionInput,
  type EngineTurnResult,
  type LlmClient,
  type LlmClientOptions,
  type LlmStructuredRequest,
  type LlmTextRequest,
  type LlmTextStreamEvent,
  type LlmUsage,
  type WorkflowEngineOptions,
} from "@pac/engine";

interface InstalledState {
  ready: boolean;
}

interface ReservedMessagesState {
  ready: boolean;
  messages: string;
}

const patchConfigFromEnv: Record<string, string | undefined> = {
  PAC_PATCH_MODEL: "smoke-model",
  PAC_PATCH_PROGRESS: "Extracting state",
  PAC_PATCH_INSTRUCTION: "Extract state updates.",
};

const connectorMetadataFromEnv: Record<string, string | undefined> = {
  USER_LOOKUP_DESCRIPTION: "Looks up a user.",
};

const lookupUserRef = defineConnectorRef({
  id: "users.lookup",
  description: connectorMetadataFromEnv.USER_LOOKUP_DESCRIPTION,
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.object({ name: z.string() }),
});

const lookupUserTool = defineConnectorTool(lookupUserRef, async ({ userId }) => ({ name: userId }));
const connectorRegistry = createConnectorRegistry([lookupUserTool]);
const lookupResult: Promise<{ name: string }> = connectorRegistry.call("users.lookup", { userId: "installed" });
void lookupResult;
// @ts-expect-error connector input must match the declared Zod schema type.
connectorRegistry.call("users.lookup", { userId: 123 });

const reservedPatch: WorkflowPatch<ReservedMessagesState> = {
  state: {
    ready: true,
  },
  messages: [],
};
void reservedPatch;

const invalidReservedPatch: WorkflowPatch<ReservedMessagesState> = {
  state: {
    // @ts-expect-error state.messages is reserved for runtime message history.
    messages: "not allowed",
  },
};
void invalidReservedPatch;

const reservedActions = workflowActions<ReservedMessagesState>();
// @ts-expect-error setState cannot write the reserved messages runtime field.
reservedActions.setState("messages", () => "not allowed");

const workflow: WorkflowDefinition<InstalledState> = {
  id: "installed_flow",
  version: "0.1.0",
  description: "Installed tarball type smoke workflow.",
  routing: defineRouting({
    examples: ["installed flow"],
    entities: ["installed"],
    neighbors: [],
  }),
  stateSchema: z.object({
    ready: z.boolean(),
  }),
  state: {
    ready: false,
  },
  patch: definePatch({
    state: {
      ready: z.boolean(),
    },
    model: patchConfigFromEnv.PAC_PATCH_MODEL,
    progress: patchConfigFromEnv.PAC_PATCH_PROGRESS,
    instruction: patchConfigFromEnv.PAC_PATCH_INSTRUCTION,
  }),
  invalidation: {},
  nodes: [
    {
      kind: "effect",
      name: "mark_ready",
      stage: "afterPatch",
      progress: "Marking ready",
      description: "Marks installed package type smoke workflow ready.",
      run: () => ({
        state: {
          ready: true,
        },
      }),
    },
  ],
  render: ({ state }): RenderResponse => ({
    text: state.ready ? "ready" : "not ready",
  }),
};

const llm: LlmClient = {
  async text(_request: LlmTextRequest) {
    return "ok";
  },
  async *streamText(_request: LlmTextRequest): AsyncIterable<LlmTextStreamEvent> {
    const usage: LlmUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    yield { type: "text_delta", delta: "ok" };
    yield { type: "done", text: "ok", usage };
  },
  async structured<TSchema extends z.ZodType>(request: LlmStructuredRequest<TSchema>): Promise<z.infer<TSchema>> {
    return request.schema.parse({ statePatch: {} });
  },
};

const llmOptions: LlmClientOptions = {
  defaultModel: "smoke-model",
};
void llmOptions;

const envConfig: Record<string, string | undefined> = {
  OPENAI_API_KEY: "smoke-key",
  OPENAI_BASE_URL: "https://example.test/v1",
  OPENAI_MODEL: "smoke-model",
};

const configuredLlm = createLlmClient({
  apiKey: envConfig.OPENAI_API_KEY,
  baseURL: envConfig.OPENAI_BASE_URL,
  defaultModel: envConfig.OPENAI_MODEL,
});
void configuredLlm;

const textRequest: LlmTextRequest = {
  name: envConfig.PAC_REQUEST_NAME,
  model: envConfig.OPENAI_MODEL,
  instruction: "Reply with ok.",
  messages: [],
};
void textRequest;

const engineOptions: WorkflowEngineOptions = {
  workflows: [workflow],
  deps: {
    connectors: connectorRegistry,
    llm,
  },
};

const engine = new WorkflowEngine(engineOptions);

const sessionInput: CreateSessionInput = {
  sessionId: "installed_session",
  userId: "installed_user",
  activeWorkflowIds: [workflow.id],
};
const session = engine.createSession(sessionInput);

const result: Promise<EngineTurnResult> = engine.onMessage("run", session);
void result;
`;
}
