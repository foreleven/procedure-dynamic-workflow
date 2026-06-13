import "dotenv/config";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import process from "node:process";
import { createConnectorRegistry, ConnectorRegistry, type AnyConnectorTool } from "@pac/workflow";
import {
  createLlmClient,
  WorkflowEngine,
  type EngineSession,
  type EngineTraceEvent,
  type WorkflowDefinitionInput,
} from "./index.js";

interface CliOptions {
  workflowPath?: string;
  connectorsPath?: string;
  model?: string;
  baseURL?: string;
  userId: string;
  sessionId: string;
  messages: string[];
  stream: boolean;
  showTraces: boolean;
  debug: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    userId: "demo_user",
    sessionId: `session_${Date.now()}`,
    messages: [],
    stream: true,
    showTraces: false,
    debug: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if ((arg === "--workflow" || arg === "-w") && next) {
      options.workflowPath = next;
      index += 1;
      continue;
    }

    if ((arg === "--connectors" || arg === "-c") && next) {
      options.connectorsPath = next;
      index += 1;
      continue;
    }

    if (arg === "--model" && next) {
      options.model = next;
      index += 1;
      continue;
    }

    if (arg === "--base-url" && next) {
      options.baseURL = next;
      index += 1;
      continue;
    }

    if (arg === "--user-id" && next) {
      options.userId = next;
      index += 1;
      continue;
    }

    if (arg === "--session-id" && next) {
      options.sessionId = next;
      index += 1;
      continue;
    }

    if ((arg === "--message" || arg === "-m" || arg === "--once") && next) {
      options.messages.push(next);
      index += 1;
      continue;
    }

    if (arg === "--no-stream") {
      options.stream = false;
      continue;
    }

    if (arg === "--traces") {
      options.showTraces = true;
      continue;
    }

    if (arg === "--debug") {
      options.debug = true;
      continue;
    }

    if (!arg.startsWith("-") && !options.workflowPath) {
      options.workflowPath = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.workflowPath) {
    throw new Error("Missing required --workflow <path>");
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage:
  npm run chat -- --workflow <workflow-file> [--connectors <connectors-file>] [--model <model>] [--base-url <url>] [--user-id <id>] [--session-id <id>] [--message <text>] [--no-stream] [--traces] [--debug]

Examples:
  npm run chat:maintenance
  npm run chat -- --workflow scenarios/maintenance/maintenance_booking.workflow.ts --connectors scenarios/maintenance/connectors.ts
  npm run chat:maintenance -- --message "我想预约保养"

Environment:
  OPENAI_MODEL      Default model used by patch extraction and render
  OPENAI_API_KEY    OpenAI-compatible API key
  OPENAI_BASE_URL   Optional OpenAI-compatible base URL

Commands inside chat:
  /help      Show commands
  /state     Print current workflow state
  /messages  Print runtime message log
  /context   Print current workflow context
  /session   Print session facts/preferences/goals
  /traces    Print last turn traces
  /exit      Quit
`);
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`File does not exist: ${absolute}`);
  }

  return import(pathToFileURL(absolute).href) as Promise<Record<string, unknown>>;
}

async function loadWorkflow(path: string): Promise<WorkflowDefinitionInput> {
  const mod = await importModule(path);
  const workflow = mod.default ?? mod.workflow;

  if (!isWorkflow(workflow)) {
    throw new Error(`Module does not export a workflow definition: ${path}`);
  }

  return workflow;
}

async function loadConnectors(path: string | undefined): Promise<ConnectorRegistry> {
  if (!path) return createConnectorRegistry();

  const mod = await importModule(path);
  const exported = mod.default ?? mod.connectors ?? mod.connectorRegistry ?? mod.connectorTools;

  if (exported instanceof ConnectorRegistry) {
    return exported;
  }

  if (Array.isArray(exported) && exported.every(isConnectorTool)) {
    return createConnectorRegistry(exported);
  }

  throw new Error(`Module does not export a connector registry or connector tool array: ${path}`);
}

function isWorkflow(value: unknown): value is WorkflowDefinitionInput {
  if (!value || typeof value !== "object") return false;
  const workflow = value as Partial<WorkflowDefinitionInput>;
  return (
    typeof workflow.id === "string" &&
    typeof workflow.version === "string" &&
    typeof workflow.description === "string" &&
    Array.isArray(workflow.nodes) &&
    Boolean(workflow.patch) &&
    typeof workflow.patch === "object" &&
    (typeof workflow.render === "function" || isRenderPolicy(workflow.render))
  );
}

function isRenderPolicy(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const render = value as Record<string, unknown>;
  return (
    typeof render.name === "string" &&
    typeof render.instruction === "string" &&
    typeof render.progress === "string"
  );
}

function isConnectorTool(value: unknown): value is AnyConnectorTool {
  if (!value || typeof value !== "object") return false;
  const tool = value as Partial<AnyConnectorTool>;
  return (
    typeof tool.id === "string" &&
    typeof tool.execute === "function" &&
    Boolean(tool.inputSchema) &&
    Boolean(tool.outputSchema)
  );
}

function printResponse(text: string): void {
  console.log(text);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, mapToJson, 2));
}

function createLogger(debug: boolean): (line: string) => void {
  if (debug) {
    return (line) => console.log(line);
  }

  return (line) => {
    const progress = progressFromLogLine(line);
    if (progress) {
      console.log(progress);
      return;
    }

    const llmDuration = llmDurationFromLogLine(line);
    if (llmDuration) {
      console.log(llmDuration);
    }
  };
}

function progressFromLogLine(line: string): string | undefined {
  if (!line.includes(" node.progress event ")) return undefined;

  const jsonStart = line.indexOf("{");
  if (jsonStart < 0) return undefined;

  try {
    const detail = JSON.parse(line.slice(jsonStart)) as { progress?: unknown };
    return typeof detail.progress === "string" ? `- ${detail.progress}` : undefined;
  } catch {
    return undefined;
  }
}

function llmDurationFromLogLine(line: string): string | undefined {
  const match = /^\[llm\] ([^ ]+) done (\d+)ms/.exec(line);
  if (!match) return undefined;

  const [, phase, durationMs] = match;
  if (phase === "text.stream") return undefined;

  return `- LLM ${phase} 耗时: ${durationMs}ms`;
}

function mapToJson(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }

  return value;
}

function sessionSnapshot(session: EngineSession): unknown {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    activeWorkflowIds: session.activeWorkflowIds,
    facts: session.facts,
    preferences: session.preferences,
    goals: session.goals,
    constraints: session.constraints,
    routingMemory: session.routingMemory,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workflowPath = options.workflowPath;
  if (!workflowPath) {
    throw new Error("Missing required --workflow <path>");
  }

  const workflow = await loadWorkflow(workflowPath);
  const connectors = await loadConnectors(options.connectorsPath);
  const logger = createLogger(options.debug);
  const llm = createLlmClient();
  let streamedChars = 0;

  const engine = new WorkflowEngine({
    workflows: [workflow],
    deps: {
      llm,
      connectors,
      now: () => new Date(),
    },
    logger,
    onResponseDelta: options.stream
      ? ({ delta }) => {
          streamedChars += delta.length;
          process.stdout.write(delta);
        }
      : undefined,
  });

  const session = engine.createSession({
    sessionId: options.sessionId,
    userId: options.userId,
    activeWorkflowIds: [workflow.id],
  });

  let lastTraces: EngineTraceEvent[] = [];

  console.log(`Loaded workflow: ${workflow.id}@${workflow.version}`);

  const handleLine = async (rawLine: string): Promise<boolean> => {
    const line = rawLine.trim();

    if (!line) return true;

    if (line === "/exit" || line === "/quit") {
      return false;
    }

    if (line === "/help") {
      console.log("Commands: /state, /messages, /context, /session, /traces, /exit");
      return true;
    }

    const instance = engine.getInstance(session, workflow.id);

    if (line === "/state") {
      printJson(instance?.state ?? null);
      return true;
    }

    if (line === "/messages") {
      printJson(instance?.state.messages ?? []);
      return true;
    }

    if (line === "/context") {
      printJson(instance?.context.toJSON() ?? null);
      return true;
    }

    if (line === "/session") {
      printJson(sessionSnapshot(session));
      return true;
    }

    if (line === "/traces") {
      printJson(lastTraces);
      return true;
    }

    try {
      streamedChars = 0;
      const time = performance.now();
      const result = await engine.onMessage(line, session);
      lastTraces = result.traces;
      const endTime = performance.now();

      if (streamedChars > 0) {
        process.stdout.write(`\n[耗时: ${(endTime - time).toFixed(2)}ms]\n`);
      } else {
        printResponse(`${result.response.text}\n[耗时: ${(endTime - time).toFixed(2)}ms]`);
      }

      if (options.showTraces) {
        printJson(result.traces);
      }
    } catch (error) {
      if (streamedChars > 0) {
        process.stdout.write("\n");
      }
      const message = error instanceof Error ? error.message : String(error);
      printResponse(`[error] ${message}`);
    }

    return true;
  };

  if (options.messages.length > 0) {
    for (const message of options.messages) {
      const shouldContinue = await handleLine(message);
      if (!shouldContinue) break;
    }
    return;
  }

  console.log("Type a message. Use /help for commands.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  const writePrompt = () => {
    if (process.stdin.isTTY) {
      process.stdout.write("> ");
    }
  };

  writePrompt();

  for await (const rawLine of rl) {
    const shouldContinue = await handleLine(rawLine);
    if (!shouldContinue) break;

    writePrompt();
  }

  rl.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
