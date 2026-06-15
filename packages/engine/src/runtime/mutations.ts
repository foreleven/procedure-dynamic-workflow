import type { JsonRecord, MessagePatch, WorkflowInstance } from "@pac/workflow";
import { applyObjectPatch, applySessionPatch } from "../patching.js";
import type { EngineSession, EngineTraceEvent } from "../types.js";
import { resetStateField } from "../utils/state.js";

/**
 * Applies a structured LLM message patch to session and workflow state.
 * Input: runtime instance, engine session, normalized message patch, and trace sink.
 * Output: workflow state fields whose semantic values changed.
 * Boundary: reserved runtime fields are filtered by applyObjectPatch before mutation.
 */
export function applyWorkflowMessagePatch(
  instance: WorkflowInstance<JsonRecord>,
  session: EngineSession,
  patch: MessagePatch,
  traces: EngineTraceEvent[],
): string[] {
  applySessionPatch(session, patch.sessionPatch);
  const dirtyFields = applyObjectPatch(instance.state, patch.statePatch ?? {});

  traces.push({
    workflowId: instance.id,
    phase: "patch",
    detail: {
      sessionPatch: patch.sessionPatch,
      statePatch: patch.statePatch,
      dirtyFields,
    },
  });

  return dirtyFields;
}

/**
 * Resets state fields invalidated by changed source fields.
 * Input: runtime instance, changed fields, trace sink, and protected same-turn message-patched fields.
 * Output: dependent state fields that were reset or deleted.
 * Boundary: invalidation metadata is definition-time validated; this applies runtime reset semantics only.
 */
export function applyWorkflowInvalidation(
  instance: WorkflowInstance<JsonRecord>,
  dirtyFields: string[],
  traces: EngineTraceEvent[],
  protectedFields: Iterable<string> = [],
): string[] {
  const invalidated: string[] = [];
  const invalidatedSet = new Set<string>();
  const state = instance.state;
  const defaults = instance.artifact.state;
  const invalidation = instance.artifact.invalidation as Record<string, string[] | undefined>;
  const dirtyFieldSet = new Set(dirtyFields);
  const protectedFieldSet = new Set(protectedFields);

  for (const field of dirtyFields) {
    for (const dependent of invalidation[field] ?? []) {
      if (dirtyFieldSet.has(dependent)) continue;
      if (protectedFieldSet.has(dependent)) continue;
      if (invalidatedSet.has(dependent)) continue;
      resetStateField(state as JsonRecord, defaults, dependent);
      invalidatedSet.add(dependent);
      invalidated.push(dependent);
    }
  }

  if (invalidated.length > 0) {
    traces.push({
      workflowId: instance.id,
      phase: "invalidate",
      detail: invalidated,
    });
  }

  return invalidated;
}
