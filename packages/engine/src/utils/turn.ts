import type { WorkflowId, WorkflowTurn } from "@pac/workflow";

/**
 * Tracks all per-workflow changes observed during a single engine turn.
 * Input: workflow ids and changed state/context/prefetch/invalidation fields.
 * Output: immutable WorkflowTurn snapshots for workflow callbacks.
 * Boundary: instances are turn-scoped and should not be stored on sessions.
 */
export class TurnChangeTracker {
  private readonly changesByWorkflow = new Map<WorkflowId, WorkflowTurnChanges>();

  forWorkflow(workflowId: WorkflowId): WorkflowTurnChanges {
    const existing = this.changesByWorkflow.get(workflowId);
    if (existing) return existing;

    const next = new WorkflowTurnChanges();
    this.changesByWorkflow.set(workflowId, next);
    return next;
  }

  snapshot(workflowId: WorkflowId): WorkflowTurn {
    return this.forWorkflow(workflowId).snapshot();
  }
}

/**
 * Mutable change accumulator for one workflow during one user turn.
 * Input: changed field names produced by patching, nodes, context, and invalidation.
 * Output: deduplicated WorkflowTurn snapshots and protected message-patched state fields.
 * Boundary: this class records names only; it never mutates workflow state.
 */
export class WorkflowTurnChanges {
  private readonly stateChangedFields = new Set<string>();
  private readonly messagePatchStateChangedFields = new Set<string>();
  private readonly contextChangedKeys = new Set<string>();
  private readonly prefetchChangedKeys = new Set<string>();
  private readonly invalidatedStateFields = new Set<string>();

  get messagePatchedStateFields(): Iterable<string> {
    return this.messagePatchStateChangedFields;
  }

  recordState(fields: readonly string[]): void {
    addAll(this.stateChangedFields, fields);
  }

  recordMessagePatchState(fields: readonly string[]): void {
    addAll(this.messagePatchStateChangedFields, fields);
  }

  recordContext(keys: readonly string[]): void {
    addAll(this.contextChangedKeys, keys);
  }

  recordPrefetch(keys: readonly string[]): void {
    addAll(this.prefetchChangedKeys, keys);
  }

  recordInvalidatedState(fields: readonly string[]): void {
    addAll(this.invalidatedStateFields, fields);
  }

  snapshot(): WorkflowTurn {
    return {
      stateChangedFields: [...this.stateChangedFields],
      contextChangedKeys: [...this.contextChangedKeys],
      prefetchChangedKeys: [...this.prefetchChangedKeys],
      invalidatedStateFields: [...this.invalidatedStateFields],
    };
  }
}

function addAll(target: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    target.add(value);
  }
}
