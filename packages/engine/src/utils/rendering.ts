import type { RenderResponse, WorkflowId } from "@pac/workflow";

export function normalizeRenderResponse(workflowId: WorkflowId, value: unknown): RenderResponse {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Workflow ${workflowId} render must return an object with string text`);
  }

  const text = renderText(workflowId, value.text, "render.text");
  if (Object.hasOwn(value, "data") && value.data !== undefined) {
    return { text, data: value.data };
  }

  return { text };
}

export function normalizeStreamTextEvent(
  workflowId: WorkflowId,
  event: unknown,
): { type: "text_delta"; delta: string } | { type: "done"; text: string } {
  if (!isRecord(event)) {
    throw new Error(`Workflow ${workflowId} streamText event must be an object`);
  }

  if (event.type === "text_delta") {
    return {
      type: "text_delta",
      delta: renderText(workflowId, event.delta, "streamText text_delta.delta"),
    };
  }

  if (event.type === "done") {
    return {
      type: "done",
      text: renderText(workflowId, event.text, "streamText done.text"),
    };
  }

  throw new Error(`Workflow ${workflowId} streamText event type must be text_delta or done`);
}

export function renderText(workflowId: WorkflowId, value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Workflow ${workflowId} ${label} must be a string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
