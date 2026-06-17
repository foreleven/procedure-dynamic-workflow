/**
 * Engine session construction and clone policies.
 *
 * This file owns the difference between read-only extension snapshots and
 * workflow-runtime session views. Extension snapshots get detached caches;
 * workflow runtime views share the live per-session cache while keeping routing
 * and transcript fields detached.
 */
import type { JsonRecord, WorkflowMessage } from "@pac/workflow";
import { cloneDefault } from "./patching.js";
import type { CreateSessionInput, EngineSession } from "./types.js";
import { copyWorkflowMessages, normalizeWorkflowMessages } from "./utils/messages.js";

export function createEngineSession(input: CreateSessionInput): EngineSession {
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    activeWorkflowIds: [...(input.activeWorkflowIds ?? [])],
    messages: normalizeWorkflowMessages(input.messages ?? []),
    facts: { ...(input.facts ?? {}) },
    preferences: { ...(input.preferences ?? {}) },
    goals: [...(input.goals ?? [])],
    constraints: [...(input.constraints ?? [])],
    sharedCache: new Map<string, unknown>(),
    routingMemory: {
      lastMatchedWorkflowIds: [],
    },
  };
}

/**
 * Clones a session for read-only extension points such as routing and render merge decisions.
 * Input: live engine session.
 * Output: detached session object with copied transcript and routing/session fields.
 * Boundary: extension code can choose or format behavior, but cannot mutate live engine lifecycle state.
 */
export function cloneEngineSessionForExtension(session: EngineSession): EngineSession {
  return cloneEngineSessionSnapshot(
    session,
    copyWorkflowMessages(session.messages),
    new Map(session.sharedCache.entries()),
  );
}

/**
 * Clones a session for workflow-owned node execution.
 * Input: live engine session and workflow-local message history for the active instance.
 * Output: detached session fields with the live per-session connector cache.
 * Boundary: workflow nodes may share connector/cache effects through `sharedCache`; routing fields stay detached.
 */
export function cloneEngineSessionForWorkflowRuntime(
  session: EngineSession,
  messages: readonly WorkflowMessage[],
): EngineSession {
  return cloneEngineSessionSnapshot(session, copyWorkflowMessages(messages), session.sharedCache);
}

export function cloneEngineSessionRecord(record: JsonRecord): JsonRecord {
  try {
    return cloneDefault(record);
  } catch {
    return { ...record };
  }
}

export function cloneEngineRoutingMemory(memory: EngineSession["routingMemory"]): EngineSession["routingMemory"] {
  return {
    ...(memory.summary === undefined ? {} : { summary: memory.summary }),
    lastMatchedWorkflowIds: [...memory.lastMatchedWorkflowIds],
    ...(memory.lastGlobalSearchAt === undefined ? {} : { lastGlobalSearchAt: memory.lastGlobalSearchAt }),
    ...(memory.suspendedWorkflowIds === undefined ? {} : { suspendedWorkflowIds: [...memory.suspendedWorkflowIds] }),
    ...(memory.lastRoutingAction === undefined ? {} : { lastRoutingAction: memory.lastRoutingAction }),
  };
}

function cloneEngineSessionSnapshot(
  session: EngineSession,
  messages: EngineSession["messages"],
  sharedCache: EngineSession["sharedCache"],
): EngineSession {
  const snapshot: EngineSession = {
    sessionId: session.sessionId,
    userId: session.userId,
    activeWorkflowIds: [...session.activeWorkflowIds],
    messages,
    facts: cloneEngineSessionRecord(session.facts),
    preferences: cloneEngineSessionRecord(session.preferences),
    goals: [...session.goals],
    constraints: [...session.constraints],
    sharedCache,
    routingMemory: cloneEngineRoutingMemory(session.routingMemory),
  };
  if (session.conversationSummary !== undefined) {
    snapshot.conversationSummary = session.conversationSummary;
  }
  return snapshot;
}
