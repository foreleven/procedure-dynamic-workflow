import type { JsonRecord } from "@pac/workflow";
import { cloneDefault } from "../patching.js";

export function resetStateField(state: JsonRecord, defaults: JsonRecord, field: string): void {
  if (Object.hasOwn(defaults, field)) {
    state[field] = cloneDefault(defaults[field]);
    return;
  }

  delete state[field];
}
