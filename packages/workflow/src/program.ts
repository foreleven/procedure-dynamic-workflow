import type { z } from "zod";
import type { PatchPolicy } from "./builders.js";
import { definePatch } from "./builders.js";
import type { ConnectorCatalog } from "./connectors.js";
import type { MaybePromise, RoutingProfile, SessionContext, WorkflowId } from "./common.js";
import { settlePrefetch } from "./prefetch.js";
import type {
  WorkflowContext,
  WorkflowDefinition,
  WorkflowRuntimeState,
  WorkflowNode,
  WorkflowNodeStage,
  WorkflowRuntimeInput,
  WorkflowToolMessage,
  WorkflowTurn,
} from "./workflow.js";
import { defineWorkflowDefinition } from "./workflow.js";

export interface ProgramRuntime<
  TState extends object = object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
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
  runtime: ProgramRuntime<TState, TConnectors>,
) => MaybePromise<boolean>;

export type ProgramStatePatch<TState extends object> = Partial<TState> & {
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
  model?: string;
  progress?: string;
  instruction?: string;
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
    runtime: ProgramRuntime<TState, TConnectors>,
  ) => MaybePromise<unknown>;
  run: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime<TState, TConnectors>,
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
    runtime: ProgramRuntime<TState, TConnectors>,
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
): WorkflowProgram<TState, TConnectors>;
export function workflow(
  config: ProgramWorkflowConfig<any, any>,
): WorkflowProgram<any, any> {
  const nodes: Array<WorkflowNode<any, any>> = [];
  let patchPolicy: PatchPolicy<unknown> | undefined;
  let invalidation = config.invalidation ?? {};

  return {
    patch(patchConfig) {
      patchPolicy = definePatch(patchConfig);
      invalidation = patchConfig.invalidates ?? invalidation;
    },
    prefetch(name, prefetchConfig) {
      registerPrefetch(name, prefetchConfig);
    },
    derive(name, effectConfig) {
      registerEffect(name, "derive", effectConfig);
    },
    command(name, effectConfig) {
      registerEffect(name, "command", effectConfig);
    },
    render(renderConfig) {
      if (!patchPolicy) {
        throw new Error(`Workflow ${config.id} must declare patch before render`);
      }

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
    prefetchConfig: ProgramPrefetchConfig<any, any>,
  ): void {
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
    kind: "derive" | "command",
    effectConfig: ProgramEffectConfig<any, any>,
  ): void {
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
        return {
          state: Object.keys(statePatch).length > 0 ? statePatch : undefined,
          messages,
        };
      },
    });
  }

  function registerNode(node: WorkflowNode<any, any>): void {
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
): ProgramRuntime<TState, TConnectors> {
  return {
    session: input.session,
    preState: input.preState,
    turn: input.turn,
    message: input.message,
  };
}

async function shouldRunPrefetch<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  state: WorkflowRuntimeState<TState>,
  context: WorkflowContext<TConnectors>,
  runtime: ProgramRuntime<TState, TConnectors>,
  config: ProgramPrefetchConfig<TState, TConnectors>,
  currentCacheKey: unknown,
): Promise<boolean> {
  if (config.cacheKey) {
    const nextCacheKey = await config.cacheKey(state, context, runtime);
    return nextCacheKey !== undefined && nextCacheKey !== null && !sameValue(currentCacheKey, nextCacheKey);
  }

  return true;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}
