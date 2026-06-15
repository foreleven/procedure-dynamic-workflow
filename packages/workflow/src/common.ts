import { z } from "zod";
import type { WorkflowMessage } from "./runtime/messages.js";

export type JsonRecord = Record<string, unknown>;
export type MaybePromise<T> = T | Promise<T>;
export type WorkflowId = string;
export type AnyZodSchema = z.ZodType;

export const JsonRecordSchema = z.record(z.string(), z.unknown());

export interface SessionContext {
  sessionId: string;
  userId: string;
  activeWorkflowIds: WorkflowId[];
  messages: WorkflowMessage[];
  facts: JsonRecord;
  preferences: JsonRecord;
  goals: string[];
  constraints: string[];
  conversationSummary?: string;
  sharedCache: Map<string, unknown>;
  routingMemory: {
    summary?: string;
    lastMatchedWorkflowIds: WorkflowId[];
    lastGlobalSearchAt?: number;
    suspendedWorkflowIds?: WorkflowId[];
    lastRoutingAction?: "continue" | "switch" | "parallel" | "clarify" | "none";
  };
}

export const SessionPatchSchema = z.object({
  facts: JsonRecordSchema.optional(),
  preferences: JsonRecordSchema.optional(),
  goals: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
});

export type SessionPatch = z.infer<typeof SessionPatchSchema>;

export interface RoutingThresholds {
  localAccept: number;
  localUncertain: number;
  globalAccept: number;
}

export interface RoutingProfile {
  examples: string[];
  entities: string[];
  neighbors: WorkflowId[];
  thresholds: RoutingThresholds;
}

export interface MessagePatch<TState extends object = JsonRecord> {
  sessionPatch?: SessionPatch;
  statePatch?: Partial<TState>;
}
