import type { WorkflowId } from "@pac/workflow";
import { safeJsonStringify } from "./json.js";

export function formatLogLine(
  workflowId: WorkflowId | "engine",
  phase: string,
  status: "start" | "done" | "skip" | "event",
  durationMs?: number,
  detail?: unknown,
): string {
  const duration = durationMs === undefined ? "" : ` ${durationMs}ms`;
  const suffix = detail === undefined ? "" : ` ${safeJsonStringify(detail)}`;
  return `[engine] ${workflowId} ${phase} ${status}${duration}${suffix}`;
}
