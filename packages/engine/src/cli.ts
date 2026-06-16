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
  loadConnectorFiles,
  loadConnectors,
  loadWorkflowFiles,
  loadWorkflows,
} from "./cli/module-loader.js";
import {
  resolveCliWorkflowSource,
  type AgentCase,
  type AgentTurn,
} from "./cli/agent-manifest.js";
import type { WorkflowSnapshot } from "./types.js";
import { errorMessage } from "./utils/errors.js";
import { safeJsonStringify } from "./utils/json.js";

function printResponse(text: string): void {
  console.log(text);
}

function responseTextForCli(result: EngineTurnResult): string {
  if (result.responses.length <= 1) return result.response.text;
  if (allResponsesSharePrimaryText(result)) return result.response.text;
  return result.responses
    .map((item) => `## ${item.workflowId}\n${item.response.text}`)
    .join("\n\n");
}

function allResponsesSharePrimaryText(result: EngineTurnResult): boolean {
  return result.responses.every((item) => item.response.text === result.response.text);
}

function printJson(value: unknown): void {
  console.log(safeJsonStringify(value, 2));
}

function sessionSnapshot(session: EngineSession): unknown {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    activeWorkflowIds: session.activeWorkflowIds,
    messages: session.messages,
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workflowSource = resolveCliWorkflowSource(options.workflowPath);
  const workflows = workflowSource.kind === "agent"
    ? await loadWorkflowFiles(workflowSource.workflowFiles)
    : await loadWorkflows(workflowSource.workflowPath);
  if (workflowSource.kind === "agent") {
    assertAgentWorkflowIds(workflowSource.workflowFiles, workflows);
  }
  const connectors = options.connectorsPath
    ? await loadConnectors(options.connectorsPath)
    : workflowSource.kind === "agent"
      ? await loadConnectorFiles(workflowSource.connectorFiles.map((file) => file.path))
      : await loadConnectors(undefined);
  const logger = createLogger(options.debug);
  const llm = createCliLlmClient(options, logger);
  let streamedChars = 0;
  let lastStreamWorkflowId: string | undefined;

  const engine = new WorkflowEngine({
    workflows,
    deps: {
      llm,
      connectors,
    },
    logger,
    ...(options.stream
      ? {
          onResponseDelta: ({ workflowId, workflowIds, delta }) => {
            const isMergedResponse = (workflowIds?.length ?? 0) > 1;
            if (!isMergedResponse && workflows.length > 1 && lastStreamWorkflowId !== workflowId) {
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

  if (workflowSource.kind === "agent") {
    console.log(
      `Loaded agent: ${workflowSource.manifest.manifestPath} (${workflowSource.manifest.cases.length} cases)`,
    );
  }

  console.log(
    `Loaded workflow${workflows.length === 1 ? "" : "s"}: ${workflows.map((workflow) => `${workflow.id}@${workflow.version}`).join(", ")}`,
  );

  const executeMessage = async (
    line: string,
    targetSession: EngineSession,
  ): Promise<EngineTurnResult | undefined> => {
    try {
      streamedChars = 0;
      lastStreamWorkflowId = undefined;
      const time = performance.now();
      const result = await engine.onMessage(line, targetSession);
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

      return result;
    } catch (error) {
      if (streamedChars > 0) {
        process.stdout.write("\n");
      }
      printResponse(`[error] ${errorMessage(error)}`);
      return undefined;
    }
  };

  const runAgentCase = async (testCase: AgentCase): Promise<void> => {
    const activeWorkflowIds = activeWorkflowIdsForCase(testCase, workflows);
    const caseSession = engine.createSession({
      sessionId: `${options.sessionId}_${testCase.id}`,
      userId: testCase.userId ?? options.userId,
      ...(activeWorkflowIds.length > 0 ? { activeWorkflowIds } : {}),
    });

    console.log(`CASE ${testCase.id}: ${testCase.description}`);

    for (const [index, turn] of testCase.turns.entries()) {
      console.log(`USER ${index + 1}: ${turn.message}`);
      const expectation = responseSatisfies(turn);
      if (expectation) {
        console.log(`EXPECT ${index + 1}: ${expectation}`);
      }
      await executeMessage(turn.message, caseSession);
    }
  };

  if (options.runAllCases || options.caseIds.length > 0) {
    if (workflowSource.kind !== "agent") {
      throw new Error("--case and --all-cases require an agent directory or agent.yaml input");
    }

    const cases = selectAgentCases(
      workflowSource.manifest.cases,
      options.caseIds,
      options.runAllCases,
    );
    for (const testCase of cases) {
      await runAgentCase(testCase);
    }
    return;
  }

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
      printJson(session.messages);
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

    await executeMessage(line, session);

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

function selectAgentCases(
  cases: AgentCase[],
  caseIds: string[],
  runAllCases: boolean,
): AgentCase[] {
  if (cases.length === 0) {
    throw new Error("Agent manifest does not define any cases");
  }

  if (runAllCases) return cases;

  const wanted = [...new Set(caseIds)];
  const byId = new Map(cases.map((item) => [item.id, item]));
  const selected: AgentCase[] = [];
  for (const caseId of wanted) {
    const testCase = byId.get(caseId);
    if (!testCase) {
      throw new Error(`Agent manifest does not define case: ${caseId}`);
    }
    selected.push(testCase);
  }

  return selected;
}

function activeWorkflowIdsForCase(
  testCase: AgentCase,
  workflows: Array<{ id: string }>,
): string[] {
  if (testCase.route === "local") return [];

  const activeWorkflowIds = testCase.workflowIds
    ?? caseDefaultActiveWorkflowIds(testCase, workflows);
  const registeredWorkflowIds = new Set(workflows.map((workflow) => workflow.id));
  const unknownWorkflowIds = activeWorkflowIds.filter(
    (workflowId) => !registeredWorkflowIds.has(workflowId),
  );
  if (unknownWorkflowIds.length > 0) {
    throw new Error(
      `Case ${testCase.id} references unknown workflow ids: ${unknownWorkflowIds.join(", ")}`,
    );
  }

  return activeWorkflowIds;
}

function caseDefaultActiveWorkflowIds(
  testCase: AgentCase,
  workflows: Array<{ id: string }>,
): string[] {
  if (workflows.length === 1 && workflows[0]) return [workflows[0].id];

  const matchingWorkflow = workflows.find((workflow) => workflow.id === testCase.id);
  if (matchingWorkflow) return [matchingWorkflow.id];

  throw new Error(
    `Case ${testCase.id} must declare workflowIds when active routing uses multiple workflows`,
  );
}

function responseSatisfies(turn: AgentTurn): string | undefined {
  const value = turn.expect?.responseSatisfies;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function assertAgentWorkflowIds(
  expected: Array<{ name: string; id: string }>,
  loaded: Array<{ id: string }>,
): void {
  for (const [index, expectedWorkflow] of expected.entries()) {
    const loadedWorkflow = loaded[index];
    if (!loadedWorkflow) {
      throw new Error(`Agent workflow ${expectedWorkflow.name} did not load`);
    }
    if (loadedWorkflow.id !== expectedWorkflow.id) {
      throw new Error(
        `Agent workflow ${expectedWorkflow.name} expected id ${expectedWorkflow.id} but loaded ${loadedWorkflow.id}`,
      );
    }
  }
}
