import "dotenv/config";

import readline from "node:readline";
import process from "node:process";
import {
  WorkflowEngine,
  type EngineSession,
  type EngineTraceEvent,
  type EngineTurnResult,
} from "./index.js";
import {
  createCliLlmClient,
  createLogger,
  parseArgs,
} from "./cli/support.js";
import {
  loadConnectors,
  loadWorkflows,
} from "./cli/module-loader.js";
import type { WorkflowSnapshot } from "./types.js";
import { errorMessage } from "./utils/errors.js";
import { safeJsonStringify } from "./utils/json.js";

function printResponse(text: string): void {
  console.log(text);
}

function responseTextForCli(result: EngineTurnResult): string {
  if (result.responses.length <= 1) return result.response.text;
  return result.responses
    .map((item) => `## ${item.workflowId}\n${item.response.text}`)
    .join("\n\n");
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

function mapSnapshotField(
  snapshots: Record<string, WorkflowSnapshot<object> | null>,
  field: "state" | "context",
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snapshots).map(([id, snapshot]) => [id, snapshot?.[field] ?? null]));
}

function mapSnapshotMessages(snapshots: Record<string, WorkflowSnapshot<object> | null>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snapshots).map(([id, snapshot]) => [id, snapshot?.state.messages ?? []]));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workflowPath = options.workflowPath;
  if (!workflowPath) {
    throw new Error("Missing required --workflow <path>");
  }

  const workflows = await loadWorkflows(workflowPath);
  const connectors = await loadConnectors(options.connectorsPath);
  const logger = createLogger(options.debug);
  const llm = createCliLlmClient(options, logger);
  let streamedChars = 0;
  let lastStreamWorkflowId: string | undefined;

  const engine = new WorkflowEngine({
    workflows,
    deps: {
      llm,
      connectors,
      now: () => new Date(),
    },
    logger,
    ...(options.stream
      ? {
          onResponseDelta: ({ workflowId, delta }: { workflowId: string; delta: string }) => {
            if (workflows.length > 1 && lastStreamWorkflowId !== workflowId) {
              if (streamedChars > 0) process.stdout.write("\n\n");
              process.stdout.write(`## ${workflowId}\n`);
              lastStreamWorkflowId = workflowId;
            }
            streamedChars += delta.length;
            process.stdout.write(delta);
          },
        }
      : {}),
  });

  const initialActiveWorkflowIds = workflows.length === 1 && workflows[0] ? [workflows[0].id] : [];
  const session = engine.createSession({
    sessionId: options.sessionId,
    userId: options.userId,
    activeWorkflowIds: initialActiveWorkflowIds,
  });

  let lastTraces: EngineTraceEvent[] = [];

  console.log(
    `Loaded workflow${workflows.length === 1 ? "" : "s"}: ${workflows.map((workflow) => `${workflow.id}@${workflow.version}`).join(", ")}`,
  );

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

    const workflowSnapshot = workflows.length === 1 && workflows[0]
      ? engine.getWorkflowSnapshot(session, workflows[0].id)
      : undefined;
    const workflowSnapshots = workflows.length > 1
      ? Object.fromEntries(workflows.map((item) => [item.id, engine.getWorkflowSnapshot(session, item.id) ?? null]))
      : undefined;

    if (line === "/state") {
      printJson(workflowSnapshots ? mapSnapshotField(workflowSnapshots, "state") : workflowSnapshot?.state ?? null);
      return true;
    }

    if (line === "/messages") {
      printJson(workflowSnapshots ? mapSnapshotMessages(workflowSnapshots) : workflowSnapshot?.state.messages ?? []);
      return true;
    }

    if (line === "/context") {
      printJson(workflowSnapshots ? mapSnapshotField(workflowSnapshots, "context") : workflowSnapshot?.context ?? null);
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
      lastStreamWorkflowId = undefined;
      const time = performance.now();
      const result = await engine.onMessage(line, session);
      lastTraces = result.traces;
      const endTime = performance.now();

      if (streamedChars > 0) {
        process.stdout.write(`\n[耗时: ${(endTime - time).toFixed(2)}ms]\n`);
      } else {
        printResponse(`${responseTextForCli(result)}\n[耗时: ${(endTime - time).toFixed(2)}ms]`);
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
