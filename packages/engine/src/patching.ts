/**
 * Runtime patch normalization and application helpers.
 *
 * This file is the engine boundary for sparse session/state deltas returned by
 * structured patch extraction and workflow nodes. It filters runtime-reserved
 * fields, preserves explicit null business values, and reports semantic dirty
 * fields without owning invalidation policy.
 */
import type { JsonRecord, MessagePatch, SessionPatch } from "@pac/workflow";
import { sameRuntimeValue } from "./utils/json.js";
import type { EngineSession } from "./types.js";

const RESERVED_STATE_FIELDS = new Set(["messages"]);

export function normalizeMessagePatch(value: unknown): MessagePatch {
  if (!isRecord(value)) return {};

  const patch: MessagePatch = {};
  const sessionPatch = normalizeSessionPatch(value.sessionPatch);
  const statePatch = normalizeRecordPatch(value.statePatch);

  if (sessionPatch) patch.sessionPatch = sessionPatch;
  if (statePatch) patch.statePatch = statePatch;

  return patch;
}

/**
 * Applies workflow-level session deltas after structured patch normalization.
 * Input: live engine session and a normalized session patch.
 * Output: facts/preferences merged and list fields appended without duplicates.
 * Boundary: session patching cannot remove prior session memory; workflow state invalidation owns local resets.
 */
export function applySessionPatch(session: EngineSession, patch: SessionPatch | undefined): void {
  if (!patch) return;

  Object.assign(session.facts, patch.facts ?? {});
  Object.assign(session.preferences, patch.preferences ?? {});
  session.goals = unique([...session.goals, ...(patch.goals ?? [])]);
  session.constraints = unique([...session.constraints, ...(patch.constraints ?? [])]);
}

/**
 * Applies a sparse object patch to mutable workflow state.
 * Input: live state object and a patch object whose undefined values were filtered at the boundary.
 * Output: state fields whose semantic value changed.
 * Boundary: reserved runtime-owned fields such as `messages` are ignored even when a schema allows them.
 */
export function applyObjectPatch(target: JsonRecord, patch: object): string[] {
  const dirtyFields: string[] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (isReservedStateField(field)) continue;
    if (!sameRuntimeValue(target[field], value)) {
      target[field] = value;
      dirtyFields.push(field);
    }
  }

  return dirtyFields;
}

export function cloneDefault<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSessionPatch(value: unknown): SessionPatch | undefined {
  if (!isRecord(value)) return undefined;

  const patch: SessionPatch = {};

  if (isRecord(value.facts)) {
    patch.facts = value.facts;
  }

  if (isRecord(value.preferences)) {
    patch.preferences = value.preferences;
  }

  if (isStringArray(value.goals)) {
    patch.goals = value.goals;
  }

  if (isStringArray(value.constraints)) {
    patch.constraints = value.constraints;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function normalizeRecordPatch(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;

  const patch: JsonRecord = {};

  for (const [key, fieldValue] of Object.entries(value)) {
    if (isReservedStateField(key)) continue;
    if (fieldValue !== undefined) {
      patch[key] = fieldValue;
    }
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isReservedStateField(field: string): boolean {
  return RESERVED_STATE_FIELDS.has(field);
}
