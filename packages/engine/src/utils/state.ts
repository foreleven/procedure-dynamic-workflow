import type { JsonRecord, WorkflowId, WorkflowInstance, WorkflowRuntimeState } from "@pac/workflow";
import { cloneDefault } from "../patching.js";
import { withRuntimeMessages } from "./messages.js";

export function resetStateField(state: JsonRecord, defaults: JsonRecord, field: string): void {
  if (Object.hasOwn(defaults, field)) {
    state[field] = cloneDefault(defaults[field]);
    return;
  }

  delete state[field];
}

export function preStateFor(
  preStates: Map<WorkflowId, WorkflowRuntimeState<JsonRecord>>,
  instance: WorkflowInstance<JsonRecord>,
): WorkflowRuntimeState<JsonRecord> {
  return preStates.get(instance.id) ?? withRuntimeMessages(cloneDefault(instance.state));
}
