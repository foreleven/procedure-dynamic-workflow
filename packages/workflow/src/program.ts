import type { z } from "zod";
import type { PatchPolicy } from "./builders.js";
import { definePatch } from "./builders.js";
import type { ConnectorCatalog } from "./connectors.js";
import type { MaybePromise, RoutingProfile, SessionContext, WorkflowId } from "./common.js";
import { sameRuntimeValue } from "./runtime/equality.js";
import { settlePrefetch } from "./runtime/prefetch.js";
import {
  assertPatchInvalidationInvariants,
  assertProgramNodeInvariants,
  assertProgramNodeStage,
  assertProgramWorkflowInvariants,
  assertRenderConfigInvariants,
} from "./definition/program-guards.js";
import type {
  WorkflowContext,
  WorkflowDefinition,
  WorkflowRuntimeState,
  WorkflowNode,
  WorkflowPatch,
  WorkflowStatePatch,
  WorkflowRuntimeInput,
  WorkflowToolMessage,
  WorkflowTurn,
} from "./workflow.js";
import { defineWorkflowDefinition } from "./workflow.js";

export interface ProgramRuntime<
  TState extends object = object,
> {
  session: SessionContext;
  preState: WorkflowRuntimeState<TState>;
  turn: WorkflowTurn;
  message?: string;
}

export type ProgramWhen<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = (
  state: WorkflowRuntimeState<TState>,
  context: WorkflowContext<TConnectors>,
  runtime: ProgramRuntime<TState>,
) => MaybePromise<boolean>;

export type ProgramStatePatch<TState extends object> = WorkflowStatePatch<TState> & {
  messages?: WorkflowToolMessage[];
};

export interface ProgramNodeMetadata {
  /**
   * User-visible progress text emitted when the node is selected to run.
   */
  progress: string;
  /**
   * Maintainer-facing explanation of the business purpose and boundary of this step.
   */
  description: string;
}

export interface ProgramWorkflowConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  id: WorkflowId;
  version: string;
  description: string;
  routing: RoutingProfile;
  stateSchema: z.ZodType<TState>;
  state: TState;
  invalidation?: Partial<Record<keyof TState & string, Array<keyof TState & string>>>;
  connectors?: TConnectors;
}

export interface ProgramPatchConfig<TState extends object, TStatePatchShape extends z.ZodRawShape> {
  state: TStatePatchShape;
  model?: string | undefined;
  progress?: string | undefined;
  instruction?: string | undefined;
  invalidates?: Partial<Record<keyof TState & string, Array<keyof TState & string>>>;
}

export interface ProgramPrefetchConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> extends ProgramNodeMetadata {
  when: ProgramWhen<TState, TConnectors>;
  cacheKey?: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime<TState>,
  ) => MaybePromise<unknown>;
  run: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime<TState>,
  ) => MaybePromise<Record<string, MaybePromise<unknown>>>;
}

export interface ProgramEffectConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> extends ProgramNodeMetadata {
  when: ProgramWhen<TState, TConnectors>;
  run: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime<TState>,
  ) => MaybePromise<ProgramStatePatch<TState> | void>;
}

export interface ProgramRenderConfig {
  name: string;
  instruction: string;
  progress: string;
}

export interface WorkflowProgram<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  patch<TStatePatchShape extends z.ZodRawShape>(
    config: ProgramPatchConfig<TState, TStatePatchShape>,
  ): void;
  prefetch(name: string, config: ProgramPrefetchConfig<TState, TConnectors>): void;
  derive(name: string, config: ProgramEffectConfig<TState, TConnectors>): void;
  command(name: string, config: ProgramEffectConfig<TState, TConnectors>): void;
  render(config: ProgramRenderConfig): WorkflowDefinition<TState, unknown, TConnectors>;
}

/**
 * Builds a workflow from business steps rather than hook registration.
 * Input: metadata and state schema/default.
 * Output: a runtime WorkflowDefinition once `render(...)` is called.
 * Boundary: this builder only compiles declarations into nodes; the engine still owns scheduling and execution.
 */
export function workflow<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  config: ProgramWorkflowConfig<TState, TConnectors>,
): WorkflowProgram<TState, TConnectors> {
  assertProgramWorkflowInvariants(config);
  const nodes: Array<WorkflowNode<TState, TConnectors>> = [];
  let patchPolicy: PatchPolicy<unknown> | undefined;
  let invalidation = config.invalidation ?? {};

  return {
    patch(patchConfig) {
      if (patchPolicy) {
        throw new Error(`Workflow ${config.id} already declared patch`);
      }
      assertPatchInvalidationInvariants(patchConfig.invalidates, `Workflow ${config.id} patch invalidates`);
      patchPolicy = definePatch(patchConfig);
      invalidation = patchConfig.invalidates ?? invalidation;
    },
    prefetch(name, prefetchConfig) {
      registerPrefetch(name, prefetchConfig);
    },
    derive(name, effectConfig) {
      registerEffect(name, effectConfig);
    },
    command(name, effectConfig) {
      registerEffect(name, effectConfig);
    },
    render(renderConfig) {
      if (!patchPolicy) {
        throw new Error(`Workflow ${config.id} must declare patch before render`);
      }
      assertRenderConfigInvariants(renderConfig, `Workflow ${config.id} render`);

      return defineWorkflowDefinition({
        id: config.id,
        version: config.version,
        description: config.description,
        routing: config.routing,
        stateSchema: config.stateSchema,
        state: config.state,
        nodes,
        patch: patchPolicy,
        invalidation,
        render: renderConfig,
      });
    },
  };

  function registerPrefetch(
    name: string,
    prefetchConfig: ProgramPrefetchConfig<TState, TConnectors>,
  ): void {
    assertProgramNodeInvariants(name, prefetchConfig, `Workflow ${config.id} prefetch`);
    const cacheKeyName = `${name}:cacheKey`;
    registerNode({
      kind: "prefetch",
      name,
      stage: "withPatch",
      progress: prefetchConfig.progress,
      description: prefetchConfig.description,
      when: async (input) => {
        const runtime = toProgramRuntime(input);
        return (
          (await prefetchConfig.when(input.state, input.context, runtime)) &&
          (await shouldRunPrefetch(input.state, input.context, runtime, prefetchConfig, input.prefetch.get(cacheKeyName)))
        );
      },
      run: async (input) => {
        const runtime = toProgramRuntime(input);
        const values = await prefetchConfig.run(input.state, input.context, runtime);
        const settled = await settlePrefetch(values);
        for (const [key, value] of Object.entries(settled)) {
          input.context.set(key, value);
        }
        if (prefetchConfig.cacheKey) {
          settled[cacheKeyName] = await prefetchConfig.cacheKey(input.state, input.context, runtime);
        }
        return settled;
      },
    });
  }

  function registerEffect(
    name: string,
    effectConfig: ProgramEffectConfig<TState, TConnectors>,
  ): void {
    assertProgramNodeInvariants(name, effectConfig, `Workflow ${config.id} node`);
    registerNode({
      kind: "effect",
      name,
      stage: "afterPatch",
      progress: effectConfig.progress,
      description: effectConfig.description,
      when: async (input) => {
        return effectConfig.when(input.state, input.context, toProgramRuntime(input));
      },
      run: async (input) => {
        const result = await effectConfig.run(input.state, input.context, toProgramRuntime(input));
        if (!result) return undefined;

        const { messages, ...statePatch } = result;
        const patch: WorkflowPatch<TState> = {};
        if (Object.keys(statePatch).length > 0) {
          // `messages` is a reserved runtime append channel; the remaining keys are workflow state fields.
          patch.state = statePatch as WorkflowStatePatch<TState>;
        }
        if (messages && messages.length > 0) {
          patch.messages = messages;
        }
        return Object.keys(patch).length > 0 ? patch : undefined;
      },
    });
  }

  function registerNode(node: WorkflowNode<TState, TConnectors>): void {
    assertProgramNodeStage(node, `Workflow ${config.id} node`);
    if (nodes.some((existing) => existing.name === node.name)) {
      throw new Error(`Duplicate workflow node: ${node.name}`);
    }
    nodes.push(node);
  }
}

function toProgramRuntime<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  input: WorkflowRuntimeInput<TState, TConnectors>,
): ProgramRuntime<TState> {
  const runtime: ProgramRuntime<TState> = {
    session: input.session,
    preState: input.preState,
    turn: input.turn,
  };

  if (input.message !== undefined) {
    runtime.message = input.message;
  }

  return runtime;
}

async function shouldRunPrefetch<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  state: WorkflowRuntimeState<TState>,
  context: WorkflowContext<TConnectors>,
  runtime: ProgramRuntime<TState>,
  config: ProgramPrefetchConfig<TState, TConnectors>,
  currentCacheKey: unknown,
): Promise<boolean> {
  if (config.cacheKey) {
    const nextCacheKey = await config.cacheKey(state, context, runtime);
    return nextCacheKey !== undefined && nextCacheKey !== null && !sameRuntimeValue(currentCacheKey, nextCacheKey);
  }

  return true;
}
