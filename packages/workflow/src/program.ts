import type { z } from "zod";
import type { PatchPolicy } from "./builders.js";
import { definePatch } from "./builders.js";
import type { ConnectorCatalog } from "./connectors.js";
import type { MaybePromise, RoutingProfile, SessionContext, WorkflowId } from "./common.js";
import { sameRuntimeValue } from "./runtime/equality.js";
import { settlePrefetch } from "./runtime/prefetch.js";
import {
  assertPatchInvalidationInvariants,
  assertProgramEffectDependencies,
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
  WorkflowStepController,
  WorkflowToolMessage,
  WorkflowTurn,
} from "./workflow.js";
import { defineWorkflowDefinition } from "./workflow.js";

export interface ProgramRuntime {
  session: SessionContext;
  turn: WorkflowTurn;
  step: WorkflowStepController;
  message?: string;
}

/**
 * Prevents author-owned state from shadowing runtime fields.
 * `messages` is appended by the engine, so workflow authors must model only business state here.
 */
type WorkflowAuthorState<TState extends object> = TState & Record<Extract<keyof TState, "messages">, never>;

export type ProgramWhen<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = (
  state: WorkflowRuntimeState<TState>,
  context: WorkflowContext<TConnectors>,
  runtime: ProgramRuntime,
) => MaybePromise<boolean>;

export type ProgramStatePatch<TState extends object> = WorkflowStatePatch<TState> & {
  messages?: WorkflowToolMessage[];
};

export type ProgramEffectDependencies<TState extends object> = readonly Exclude<keyof TState & string, "messages">[];

export interface ProgramNodeMetadata {
  /**
   * Maintainer-facing explanation of the business purpose and boundary of this step.
   */
  description: string;
}

export interface ProgramProgressNodeMetadata {
  /**
   * Maintainer-facing explanation of the business purpose and boundary of this step.
   */
  description: string;
  /**
   * User-visible progress text emitted when the node is selected to run.
   */
  progress: string;
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
  state: WorkflowAuthorState<TState>;
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
> extends ProgramProgressNodeMetadata {
  when: ProgramWhen<TState, TConnectors>;
  cacheKey?: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime,
  ) => MaybePromise<unknown>;
  run: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime,
  ) => MaybePromise<Record<string, MaybePromise<unknown>>>;
}

export interface ProgramEffectConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> extends ProgramNodeMetadata {
  /**
   * State fields that gate this effect. The node runs once when the dependency
   * snapshot changes and is skipped on later stabilization rounds until it changes again.
   */
  dependsOn?: ProgramEffectDependencies<TState>;
  run: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime,
    step: WorkflowStepController,
  ) => MaybePromise<ProgramStatePatch<TState> | void>;
}

export interface ProgramCommandConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> extends ProgramNodeMetadata {
  when: ProgramWhen<TState, TConnectors>;
  run: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramRuntime,
    step: WorkflowStepController,
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
  effect(name: string, config: ProgramEffectConfig<TState, TConnectors>): void;
  effect(
    name: string,
    dependsOn: ProgramEffectDependencies<TState>,
    config: ProgramEffectConfig<TState, TConnectors>,
  ): void;
  derive(name: string, config: ProgramEffectConfig<TState, TConnectors>): void;
  derive(
    name: string,
    dependsOn: ProgramEffectDependencies<TState>,
    config: ProgramEffectConfig<TState, TConnectors>,
  ): void;
  command(name: string, config: ProgramCommandConfig<TState, TConnectors>): void;
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

  function effect(name: string, effectConfig: ProgramEffectConfig<TState, TConnectors>): void;
  function effect(
    name: string,
    dependsOn: ProgramEffectDependencies<TState>,
    effectConfig: ProgramEffectConfig<TState, TConnectors>,
  ): void;
  function effect(
    name: string,
    dependenciesOrConfig:
      | ProgramEffectDependencies<TState>
      | ProgramEffectConfig<TState, TConnectors>,
    maybeConfig?: ProgramEffectConfig<TState, TConnectors>,
  ): void {
    registerEffect(name, normalizeEffectConfig(dependenciesOrConfig, maybeConfig));
  }

  function derive(name: string, effectConfig: ProgramEffectConfig<TState, TConnectors>): void;
  function derive(
    name: string,
    dependsOn: ProgramEffectDependencies<TState>,
    effectConfig: ProgramEffectConfig<TState, TConnectors>,
  ): void;
  function derive(
    name: string,
    dependenciesOrConfig:
      | ProgramEffectDependencies<TState>
      | ProgramEffectConfig<TState, TConnectors>,
    maybeConfig?: ProgramEffectConfig<TState, TConnectors>,
  ): void {
    registerEffect(name, normalizeEffectConfig(dependenciesOrConfig, maybeConfig));
  }

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
    effect,
    derive,
    command(name, commandConfig) {
      registerCommand(name, commandConfig);
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
    assertProgramNodeInvariants(name, prefetchConfig, `Workflow ${config.id} prefetch`, { requireProgress: true });
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
    assertProgramEffectDependencies(effectConfig.dependsOn, `Workflow ${config.id} node ${name} dependsOn`);
    registerNode({
      kind: "effect",
      name,
      stage: "afterPatch",
      description: effectConfig.description,
      ...(effectConfig.dependsOn !== undefined ? { dependsOn: [...effectConfig.dependsOn] } : {}),
      run: async (input) => {
        const result = await effectConfig.run(input.state, input.context, toProgramRuntime(input), input.step);
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

  function registerCommand(
    name: string,
    commandConfig: ProgramCommandConfig<TState, TConnectors>,
  ): void {
    assertProgramNodeInvariants(name, commandConfig, `Workflow ${config.id} command`);
    registerNode({
      kind: "effect",
      name,
      stage: "afterPatch",
      description: commandConfig.description,
      when: async (input) => commandConfig.when(input.state, input.context, toProgramRuntime(input)),
      run: async (input) => {
        const result = await commandConfig.run(input.state, input.context, toProgramRuntime(input), input.step);
        if (!result) return undefined;

        const { messages, ...statePatch } = result;
        const patch: WorkflowPatch<TState> = {};
        if (Object.keys(statePatch).length > 0) {
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
): ProgramRuntime {
  const runtime: ProgramRuntime = {
    session: input.session,
    turn: input.turn,
    step: input.step,
  };

  if (input.message !== undefined) {
    runtime.message = input.message;
  }

  return runtime;
}

function normalizeEffectConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  dependenciesOrConfig:
    | ProgramEffectDependencies<TState>
    | ProgramEffectConfig<TState, TConnectors>,
  maybeConfig?: ProgramEffectConfig<TState, TConnectors>,
): ProgramEffectConfig<TState, TConnectors> {
  if (isEffectDependencies(dependenciesOrConfig)) {
    if (!maybeConfig) {
      throw new Error("Workflow effect dependencies must be followed by an effect config");
    }

    return {
      ...maybeConfig,
      dependsOn: dependenciesOrConfig,
    };
  }

  return dependenciesOrConfig;
}

function isEffectDependencies<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  value:
    | ProgramEffectDependencies<TState>
    | ProgramEffectConfig<TState, TConnectors>,
): value is ProgramEffectDependencies<TState> {
  return Array.isArray(value);
}

async function shouldRunPrefetch<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  state: WorkflowRuntimeState<TState>,
  context: WorkflowContext<TConnectors>,
  runtime: ProgramRuntime,
  config: ProgramPrefetchConfig<TState, TConnectors>,
  currentCacheKey: unknown,
): Promise<boolean> {
  if (config.cacheKey) {
    const nextCacheKey = await config.cacheKey(state, context, runtime);
    return nextCacheKey !== undefined && nextCacheKey !== null && !sameRuntimeValue(currentCacheKey, nextCacheKey);
  }

  return true;
}
