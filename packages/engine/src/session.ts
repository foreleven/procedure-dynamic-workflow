import type { JsonRecord, SessionContext } from "@pac/workflow";
import type { CreateSessionInput, EngineSession } from "./types.js";
import { normalizeWorkflowMessages } from "./utils/messages.js";

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

export function sessionForLlm(session: EngineSession): Omit<SessionContext, "sharedCache"> & {
  sharedCache: JsonRecord;
} {
  const snapshot: Omit<SessionContext, "sharedCache"> & {
    sharedCache: JsonRecord;
  } = {
    sessionId: session.sessionId,
    userId: session.userId,
    activeWorkflowIds: session.activeWorkflowIds,
    messages: session.messages,
    facts: session.facts,
    preferences: session.preferences,
    goals: session.goals,
    constraints: session.constraints,
    sharedCache: Object.fromEntries(session.sharedCache.entries()),
    routingMemory: session.routingMemory,
  };

  if (session.conversationSummary !== undefined) {
    snapshot.conversationSummary = session.conversationSummary;
  }

  return snapshot;
}
