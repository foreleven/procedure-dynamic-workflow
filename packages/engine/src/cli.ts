import "dotenv/config";

import readline from "node:readline";
import process from "node:process";
import {
  WorkflowEngine,
  type EngineSession,
  type EngineTraceEvent,
} from "./index.js";
import {
  createCliLlmClient,
  createLogger,
  parseArgs,
} from "./cli/support.js";
import {
  loadConnectors,
  loadWorkflow,
} from "./cli/module-loader.js";
import { errorMessage } from "./utils/errors.js";
import { safeJsonStringify } from "./utils/json.js";

function printResponse(text: string): void {
  console.log(text);
}

function printJson(value: unknown): void {
  console.log(safeJsonStringify(value, 2));
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
  const llm = createCliLlmClient(options, logger);
  let streamedChars = 0;

  const engine = new WorkflowEngine({
    workflows: [workflow],
    deps: {
      llm,
      connectors,
      now: () => new Date(),
    },
    logger,
    ...(options.stream
      ? {
          onResponseDelta: ({ delta }: { workflowId: string; delta: string }) => {
            streamedChars += delta.length;
            process.stdout.write(delta);
          },
        }
      : {}),
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

    const workflowSnapshot = engine.getWorkflowSnapshot(session, workflow.id);

    if (line === "/state") {
      printJson(workflowSnapshot?.state ?? null);
      return true;
    }

    if (line === "/messages") {
      printJson(workflowSnapshot?.state.messages ?? []);
      return true;
    }

    if (line === "/context") {
      printJson(workflowSnapshot?.context ?? null);
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
      printResponse(`[error] ${errorMessage(error)}`);
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
  console.error(errorMessage(error));
  process.exit(1);
});
