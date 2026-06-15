import {
  type JsonRecord,
  PrefetchStore,
  WorkflowContextStore,
  type WorkflowId,
  type WorkflowInstance,
} from "@pac/workflow";
import { cloneDefault } from "../patching.js";
import type { EngineDeps, EngineSession, RuntimeWorkflow, WorkflowSnapshot } from "../types.js";
import { safeJsonStringify } from "../utils/json.js";
import { withRuntimeMessages } from "../utils/messages.js";

/**
 * Owns per-session workflow runtime instances for an engine registry.
 * Input: immutable runtime workflow registry plus the connector dependency shared by new contexts.
 * Output: session-scoped WorkflowInstance objects and immutable snapshots.
 * Boundary: this class owns instance lifecycle only; turn scheduling and workflow execution stay in WorkflowEngine.
 */
export class WorkflowInstanceStore {
  private readonly sessionInstances = new WeakMap<EngineSession, Map<WorkflowId, WorkflowInstance<JsonRecord>>>();

  constructor(
    private readonly registry: ReadonlyMap<WorkflowId, RuntimeWorkflow>,
    private readonly connectors: EngineDeps["connectors"],
  ) {}

  /**
   * Registers a freshly created session and eagerly creates its active workflow instances.
   * Input: engine session after public createSession validation.
   * Output: session-instance map ready for turn execution.
   * Boundary: this does not validate active workflow ids; WorkflowEngine owns registry-level session validation.
   */
  initializeSession(session: EngineSession): void {
    this.sessionInstances.set(session, new Map());
    for (const workflowId of session.activeWorkflowIds) {
      this.ensure(session, workflowId);
    }
  }

  /**
   * Returns an immutable snapshot of one workflow instance for diagnostics and CLI inspection.
   * Input: session and workflow id.
   * Output: cloned workflow state, context, and prefetch data, or undefined when the instance is absent.
   * Boundary: snapshot cloning is diagnostic only; workflow execution continues to use live runtime instances.
   */
  snapshot<TState extends object>(
    session: EngineSession,
    workflowId: WorkflowId,
  ): WorkflowSnapshot<TState> | undefined {
    const instance = this.sessionInstances.get(session)?.get(workflowId);
    if (!instance) return undefined;

    return {
      id: instance.id,
      version: instance.version,
      state: cloneSnapshotValue(withRuntimeMessages(instance.state, session.messages)) as WorkflowSnapshot<TState>["state"],
      context: cloneSnapshotValue(instance.context.toJSON()),
      prefetch: cloneSnapshotValue(instance.prefetch.toJSON()),
    };
  }

  /**
   * Resolves active workflow instances that are still part of the current target set.
   * Input: session and target workflow ids selected earlier in the turn.
   * Output: runtime instances in active workflow order.
   * Boundary: this does not attach new workflows; routing owns target selection.
   */
  forActiveTargets(session: EngineSession, targetIds: Set<WorkflowId>): WorkflowInstance<JsonRecord>[] {
    return this.forIds(
      session,
      session.activeWorkflowIds.filter((id) => targetIds.has(id)),
    );
  }

  /**
   * Resolves workflow ids into session-scoped runtime instances.
   * Input: session and known workflow ids.
   * Output: existing or newly created instances, omitting ids missing from the registry.
   * Boundary: callers validate unknown ids when unknown ids should be treated as errors.
   */
  forIds(session: EngineSession, workflowIds: WorkflowId[]): WorkflowInstance<JsonRecord>[] {
    return workflowIds
      .map((id) => this.ensure(session, id))
      .filter((instance): instance is WorkflowInstance<JsonRecord> => Boolean(instance));
  }

  /**
   * Returns an existing runtime instance or creates it from the registered workflow artifact.
   * Input: session and workflow id.
   * Output: runtime instance with fresh context/state/prefetch, or undefined for unknown workflow ids.
   * Boundary: this creates in-memory runtime state only; workflow callbacks are not executed here.
   */
  ensure(session: EngineSession, workflowId: WorkflowId): WorkflowInstance<JsonRecord> | undefined {
    const instances = this.instancesForSession(session);
    const existing = instances.get(workflowId);
    if (existing) return existing;

    const artifact = this.registry.get(workflowId);
    if (!artifact) return undefined;

    const instance: WorkflowInstance<JsonRecord> = {
      id: artifact.id,
      version: artifact.version,
      artifact,
      context: new WorkflowContextStore(this.connectors),
      state: withRuntimeMessages(artifact.stateSchema.parse(cloneDefault(artifact.state)), session.messages),
      prefetch: new PrefetchStore(),
    };

    instances.set(workflowId, instance);
    return instance;
  }

  /**
   * Adds a workflow to the session's active list and prepares its runtime instance.
   * Input: session and workflow id selected by the routing subsystem.
   * Output: mutates session.activeWorkflowIds only when the workflow is registered and not already active.
   * Boundary: selection scoring remains in WorkflowEngine; this only applies the attachment.
   */
  attach(session: EngineSession, workflowId: WorkflowId): void {
    if (!this.registry.has(workflowId) || session.activeWorkflowIds.includes(workflowId)) return;
    session.activeWorkflowIds.push(workflowId);
    this.ensure(session, workflowId);
  }

  private instancesForSession(session: EngineSession): Map<WorkflowId, WorkflowInstance<JsonRecord>> {
    let instances = this.sessionInstances.get(session);
    if (!instances) {
      instances = new Map();
      this.sessionInstances.set(session, instances);
    }
    return instances;
  }
}

function cloneSnapshotValue<T>(value: T): T {
  try {
    return cloneDefault(value);
  } catch {
    return JSON.parse(safeJsonStringify(value)) as T;
  }
}
