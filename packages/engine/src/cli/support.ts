import process from "node:process";
import {
  createLlmClient,
  type LlmClient,
} from "../index.js";

export interface CliOptions {
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

/**
 * Parses chat CLI arguments into a fully defaulted runtime configuration.
 * Input: process argv tokens after the executable and script path.
 * Output: validated CLI options, or process exit after printing help.
 * Boundary: this parser validates argument shape only; file existence and module exports are loaded later.
 */
export function parseArgs(argv: string[]): CliOptions {
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

    if (arg === "--workflow" || arg === "-w") {
      options.workflowPath = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }

    if (arg === "--connectors" || arg === "-c") {
      options.connectorsPath = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }

    if (arg === "--model") {
      options.model = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }

    if (arg === "--base-url") {
      options.baseURL = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }

    if (arg === "--user-id") {
      options.userId = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }

    if (arg === "--session-id") {
      options.sessionId = readRequiredOptionValue(arg, next);
      index += 1;
      continue;
    }

    if (arg === "--message" || arg === "-m" || arg === "--once") {
      options.messages.push(readRequiredOptionValue(arg, next, { allowFlagLikeValue: true }));
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
  }

  if (!options.workflowPath) {
    throw new Error("Missing required --workflow <path>");
  }

  return options;
}

/**
 * Builds the CLI log sink used for debug logs and user-visible progress.
 * Input: whether debug logging is enabled.
 * Output: logger compatible with the engine and LLM clients.
 * Boundary: non-debug mode emits only progress and non-streaming LLM duration summaries.
 */
export function createLogger(debug: boolean): (line: string) => void {
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

/**
 * Builds the CLI LLM client from explicit flags first, then environment fallbacks.
 * Input: parsed CLI options and a log sink shared with engine progress.
 * Output: an LLM client configured for OpenAI-compatible completion APIs.
 * Boundary: this helper only wires configuration; workflow-level model overrides still win per request.
 */
export function createCliLlmClient(options: CliOptions, logger: (line: string) => void): LlmClient {
  const apiKey = firstConfigured(process.env.OPENAI_API_KEY);
  const baseURL = firstConfigured(options.baseURL, process.env.OPENAI_BASE_URL);
  const defaultModel = firstConfigured(options.model, process.env.OPENAI_MODEL);

  return createLlmClient({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    logger,
  });
}

/**
 * Reads a required value for a CLI flag before the parser consumes the next token.
 * Input: current option name, next argv token, and whether flag-like values are valid payloads.
 * Output: the validated option value.
 * Boundary: message payloads may intentionally start with `-`; file/config flags may not.
 */
function readRequiredOptionValue(
  option: string,
  value: string | undefined,
  config: { allowFlagLikeValue?: boolean } = {},
): string {
  if (!value || (!config.allowFlagLikeValue && value.startsWith("-"))) {
    throw new Error(`Missing value for ${option}`);
  }

  return value;
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

function firstConfigured(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }

  return undefined;
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
