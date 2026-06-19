import type { WorkflowId } from "@pac/workflow";
import type { EngineEventSink, EngineTraceEvent, WorkflowEngineOptions } from "../types.js";
import { formatLogLine } from "../utils/logging.js";

export interface RuntimeProgressDetail {
  node: string;
  stage: string;
  progress: string;
  description?: string;
}

export interface RuntimeStepDetail {
  node: string;
  stage: string;
  stepId: string;
  parentStepId?: string;
  label: string;
  status?: "done" | "error";
  durationMs?: number;
  detail?: unknown;
}

/**
 * Emits one diagnostic trace to the turn event stream.
 * Input: the trace entry and the current event sink.
 * Output: an `engine.trace` payload for streaming consumers.
 * Boundary: this helper does not write logs; callers keep logger semantics explicit.
 */
export function recordEngineTrace(
  trace: EngineTraceEvent,
  events: EngineEventSink,
): void {
  events.emit({
    event: {
      type: "engine.trace",
      trace,
    },
  });
}

/**
 * Centralizes engine trace and log emission.
 * Input: optional engine logger plus the current turn event sink.
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

  trace(trace: EngineTraceEvent, events: EngineEventSink): void {
    recordEngineTrace(trace, events);
  }

  progress(
    workflowId: WorkflowId,
    detail: RuntimeProgressDetail,
    events: EngineEventSink,
  ): void {
    this.trace({
      workflowId,
      phase: "node.progress",
      detail,
    }, events);
    events.emit({
      event: {
        type: "workflow.step.progress",
        workflowId,
        node: detail.node,
        stage: detail.stage,
        progress: detail.progress,
        ...(detail.description === undefined ? {} : { description: detail.description }),
      },
    });
    this.event(workflowId, "node.progress", detail);
  }

  stepStart(
    workflowId: WorkflowId,
    detail: RuntimeStepDetail,
    events: EngineEventSink,
  ): void {
    this.trace({
      workflowId,
      phase: "node.step.start",
      detail,
    }, events);
    events.emit({
      event: {
        type: "workflow.step.start",
        workflowId,
        node: detail.node,
        stage: detail.stage,
        stepId: detail.stepId,
        ...(detail.parentStepId === undefined ? {} : { parentStepId: detail.parentStepId }),
        label: detail.label,
        ...(detail.detail === undefined ? {} : { detail: detail.detail }),
      },
    });
    this.event(workflowId, "node.step.start", detail);
  }

  stepEnd(
    workflowId: WorkflowId,
    detail: RuntimeStepDetail,
    events: EngineEventSink,
  ): void {
    this.trace({
      workflowId,
      phase: "node.step.end",
      detail,
    }, events);
    events.emit({
      event: {
        type: "workflow.step.end",
        workflowId,
        node: detail.node,
        stage: detail.stage,
        stepId: detail.stepId,
        ...(detail.parentStepId === undefined ? {} : { parentStepId: detail.parentStepId }),
        label: detail.label,
        ...(detail.status === undefined ? {} : { status: detail.status }),
        ...(detail.durationMs === undefined ? {} : { durationMs: detail.durationMs }),
        ...(detail.detail === undefined ? {} : { detail: detail.detail }),
      },
    });
    this.event(workflowId, "node.step.end", detail);
  }
}
