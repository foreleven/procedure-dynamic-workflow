import type { WorkflowId } from "@pac/workflow";
import type { EngineTraceEvent, WorkflowEngineOptions } from "../types.js";
import { formatLogLine } from "../utils/logging.js";

export interface RuntimeProgressDetail {
  node: string;
  stage: string;
  progress: string;
  description?: string;
}

/**
 * Centralizes engine trace and log emission.
 * Input: optional engine logger plus trace arrays supplied by turn execution.
 * Output: stable log lines and trace events for runtime diagnostics.
 * Boundary: this class never mutates workflow state; it only records execution metadata.
 */
export class RuntimeTracer {
  constructor(private readonly logger: WorkflowEngineOptions["logger"]) {}

  start(workflowId: WorkflowId | "engine", phase: string, detail?: unknown): number {
    this.logger?.(formatLogLine(workflowId, phase, "start", undefined, detail));
    return Date.now();
  }

  done(workflowId: WorkflowId | "engine", phase: string, startedAt: number, detail?: unknown): void {
    this.logger?.(formatLogLine(workflowId, phase, "done", Date.now() - startedAt, detail));
  }

  skip(workflowId: WorkflowId | "engine", phase: string, detail?: unknown): void {
    this.logger?.(formatLogLine(workflowId, phase, "skip", undefined, detail));
  }

  event(workflowId: WorkflowId | "engine", phase: string, detail?: unknown): void {
    this.logger?.(formatLogLine(workflowId, phase, "event", undefined, detail));
  }

  progress(traces: EngineTraceEvent[], workflowId: WorkflowId, detail: RuntimeProgressDetail): void {
    traces.push({
      workflowId,
      phase: "node.progress",
      detail,
    });
    this.event(workflowId, "node.progress", detail);
  }
}
