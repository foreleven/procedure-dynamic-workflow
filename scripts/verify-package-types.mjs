import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempDir = resolve(".tmp/package-types");

rmSync(tempDir, { recursive: true, force: true });
mkdirSync(tempDir, { recursive: true });

writeFileSync(
  resolve(tempDir, "package.json"),
  JSON.stringify({ type: "module", private: true }, null, 2),
);

writeFileSync(
  resolve(tempDir, "tsconfig.json"),
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
        types: ["node"],
      },
      include: ["consumer.ts"],
    },
    null,
    2,
  ),
);

writeFileSync(resolve(tempDir, "consumer.ts"), consumerSource());

try {
  await execFileAsync("npx", ["tsc", "-p", resolve(tempDir, "tsconfig.json"), "--noEmit"], {
    maxBuffer: 1024 * 1024 * 10,
  });
  console.log("ok package types: external TypeScript consumer compiled");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

/**
 * Builds a small external consumer that imports packages through their npm entry points.
 * Input: none; package resolution intentionally goes through node_modules and package exports.
 * Output: TypeScript source that exercises the public workflow and engine types.
 * Boundary: this does not execute the engine or call an LLM; it verifies published declaration usability.
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

interface ConsumerState {
  userId: string | null;
  status: "idle" | "ready";
}

interface ReservedMessagesState {
  status: string;
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
const lookupResult: Promise<{ name: string }> = connectorRegistry.call("users.lookup", { userId: "consumer" });
void lookupResult;
// @ts-expect-error connector input must match the declared Zod schema type.
connectorRegistry.call("users.lookup", { userId: 123 });

const reservedPatch: WorkflowPatch<ReservedMessagesState> = {
  state: {
    status: "ok",
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

const workflow: WorkflowDefinition<ConsumerState> = {
  id: "consumer_flow",
  version: "0.1.0",
  description: "External consumer type smoke workflow.",
  routing: defineRouting({
    examples: ["consumer flow"],
    entities: ["consumer"],
    neighbors: [],
  }),
  stateSchema: z.object({
    userId: z.string().nullable(),
    status: z.enum(["idle", "ready"]),
  }),
  state: {
    userId: null,
    status: "idle",
  },
  patch: definePatch({
    state: {
      userId: z.string().nullable(),
      status: z.enum(["idle", "ready"]),
    },
    model: patchConfigFromEnv.PAC_PATCH_MODEL,
    progress: patchConfigFromEnv.PAC_PATCH_PROGRESS,
    instruction: patchConfigFromEnv.PAC_PATCH_INSTRUCTION,
  }),
  invalidation: {
    userId: ["status"],
  },
  nodes: [
    {
      kind: "effect",
      name: "mark_ready",
      stage: "afterPatch",
      progress: "Marking ready",
      description: "Marks the workflow state ready for external type smoke coverage.",
      when: ({ state }) => state.userId !== null,
      run: ({ state }) => ({
        state: {
          status: state.userId ? "ready" : "idle",
        },
      }),
    },
  ],
  render: ({ state }): RenderResponse => ({
    text: state.status,
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
  sessionId: "consumer_session",
  userId: "consumer_user",
  activeWorkflowIds: [workflow.id],
};
const session = engine.createSession(sessionInput);

const turn: Promise<EngineTurnResult> = engine.onMessage("hello", session);
void turn;
`;
}
