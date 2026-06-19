import type { z } from "zod";
import type { PatchPolicy } from "./builders.js";
import { definePatch } from "./builders.js";
import type { ConnectorCatalog } from "./connectors.js";
import type { MaybePromise, SessionContext } from "./common.js";
import { sameRuntimeValue } from "./runtime/equality.js";
import { settlePrefetch } from "./runtime/prefetch.js";
import {
  assertPatchInvalidationInvariants,
  assertProgramEffectDependencies,
  assertProgramLoopConfigInvariants,
  assertProgramLoopEffectDependencies,
  assertProgramNodeInvariants,
  assertProgramNodeStage,
  assertProgramWorkflowInvariants,
  assertRenderConfigInvariants,
} from "./definition/program-guards.js";
import type {
  WorkflowContext,
  WorkflowDefinition,
  WorkflowDefinitionMetadata,
  WorkflowDefinitionTemplate,
  WorkflowRuntimeState,
  WorkflowNode,
  WorkflowPatch,
  WorkflowStatePatch,
  WorkflowRuntimeInput,
  WorkflowLoopRuntime,
  WorkflowStepController,
  WorkflowToolMessage,
  WorkflowTurn,
} from "./workflow.js";
import {
  defineWorkflowDefinition,
  defineWorkflowTemplate,
} from "./workflow.js";

export interface ProgramRuntime {
  session: SessionContext;
  turn: WorkflowTurn;
  step: WorkflowStepController;
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

export type ProgramStateDependency<TState extends object> = Exclude<keyof TState & string, "messages">;
export type ProgramLoopDependency = `loop.${string}`;
export type ProgramEffectDependencies<TState extends object> = readonly (
  | ProgramStateDependency<TState>
  | ProgramLoopDependency
)[];
export type ProgramLoopEffectDependencies = readonly string[];

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

export interface ProgramWorkflowBaseConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  stateSchema: z.ZodType<TState>;
  state: WorkflowAuthorState<TState>;
  invalidation?: Partial<Record<keyof TState & string, Array<keyof TState & string>>>;
  connectors?: TConnectors;
}

export interface ProgramWorkflowConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> extends ProgramWorkflowBaseConfig<TState, TConnectors>, WorkflowDefinitionMetadata {}

export type ProgramWorkflowTemplateConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = ProgramWorkflowBaseConfig<TState, TConnectors>;

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

export interface ProgramLoopConfig<
  TState extends object,
  TLoopState extends object,
> extends ProgramNodeMetadata {
  /**
   * State fields or completed loop names that gate this loop.
   */
  dependsOn?: ProgramEffectDependencies<TState>;
  maxRuns: number;
  stateSchema: z.ZodType<TLoopState>;
  model?: string | undefined;
  instruction: string;
}

export type ProgramLoopRuntime<TLoopState extends object> = ProgramRuntime & {
  loop: WorkflowLoopRuntime<TLoopState>;
};

export interface ProgramLoopEffectConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
  TLoopState extends object = Record<string, unknown>,
> extends ProgramNodeMetadata {
  dependsOn?: ProgramLoopEffectDependencies;
  run: (
    state: WorkflowRuntimeState<TState>,
    context: WorkflowContext<TConnectors>,
    runtime: ProgramLoopRuntime<TLoopState>,
    step: WorkflowStepController,
  ) => MaybePromise<ProgramStatePatch<TState> | void>;
}

export interface ProgramLoop<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
  TLoopState extends object = Record<string, unknown>,
> {
  effect(name: string, config: ProgramLoopEffectConfig<TState, TConnectors, TLoopState>): void;
  effect(
    name: string,
    dependsOn: ProgramLoopEffectDependencies,
    config: ProgramLoopEffectConfig<TState, TConnectors, TLoopState>,
  ): void;
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

interface WorkflowProgramBase<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
  TRenderOutput = WorkflowDefinition<TState, unknown, TConnectors>,
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
  loop<TLoopState extends object>(
    name: string,
    config: ProgramLoopConfig<TState, TLoopState>,
  ): ProgramLoop<TState, TConnectors, TLoopState>;
  command(name: string, config: ProgramCommandConfig<TState, TConnectors>): void;
  render(config: ProgramRenderConfig): TRenderOutput;
}

export type WorkflowProgram<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = WorkflowProgramBase<TState, TConnectors, WorkflowDefinition<TState, unknown, TConnectors>>;

export type WorkflowTemplateProgram<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = WorkflowProgramBase<TState, TConnectors, WorkflowDefinitionTemplate<TState, unknown, TConnectors>>;

/**
 * Builds a workflow from business steps rather than hook registration.
 * Input: state schema/default plus optional standalone metadata.
 * Output: a complete definition when metadata is supplied, otherwise a manifest-backed template.
 * Boundary: this builder only compiles declarations into nodes; the engine still owns scheduling and execution.
 */
export function workflow<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  config: ProgramWorkflowConfig<TState, TConnectors>,
): WorkflowProgram<TState, TConnectors>;
export function workflow<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  config: ProgramWorkflowTemplateConfig<TState, TConnectors>,
): WorkflowTemplateProgram<TState, TConnectors>;
export function workflow<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  config: ProgramWorkflowConfig<TState, TConnectors> | ProgramWorkflowTemplateConfig<TState, TConnectors>,
): WorkflowProgram<TState, TConnectors> | WorkflowTemplateProgram<TState, TConnectors> {
  assertProgramWorkflowInvariants(config);
  const nodes: Array<WorkflowNode<TState, TConnectors>> = [];
  let patchPolicy: PatchPolicy<unknown> | undefined;
  let invalidation = config.invalidation ?? {};
  const metadata = workflowMetadata(config);
  const label = metadata ? `Workflow ${metadata.id}` : "Workflow template";

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

  const program: WorkflowProgramBase<
    TState,
    TConnectors,
    WorkflowDefinition<TState, unknown, TConnectors> | WorkflowDefinitionTemplate<TState, unknown, TConnectors>
  > = {
    patch(patchConfig) {
      if (patchPolicy) {
        throw new Error(`${label} already declared patch`);
      }
      assertPatchInvalidationInvariants(patchConfig.invalidates, `${label} patch invalidates`);
      patchPolicy = definePatch(patchConfig);
      invalidation = patchConfig.invalidates ?? invalidation;
    },
    prefetch(name, prefetchConfig) {
      registerPrefetch(name, prefetchConfig);
    },
    effect,
    derive,
    loop(name, loopConfig) {
      return registerLoop(name, loopConfig);
    },
    command(name, commandConfig) {
      registerCommand(name, commandConfig);
    },
    render(renderConfig) {
      if (!patchPolicy) {
        throw new Error(`${label} must declare patch before render`);
      }
      assertRenderConfigInvariants(renderConfig, `${label} render`);

      const body = {
        stateSchema: config.stateSchema,
        state: config.state,
        nodes,
        patch: patchPolicy,
        invalidation,
        render: renderConfig,
      };

      return metadata
        ? defineWorkflowDefinition({
            ...metadata,
            ...body,
          })
        : defineWorkflowTemplate(body);
    },
  };
  return metadata
    ? program as WorkflowProgram<TState, TConnectors>
    : program as WorkflowTemplateProgram<TState, TConnectors>;

  function registerPrefetch(
    name: string,
    prefetchConfig: ProgramPrefetchConfig<TState, TConnectors>,
  ): void {
    assertProgramNodeInvariants(name, prefetchConfig, `${label} prefetch`, { requireProgress: true });
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
    assertProgramNodeInvariants(name, effectConfig, `${label} node`);
    assertProgramEffectDependencies(effectConfig.dependsOn, `${label} node ${name} dependsOn`);
    registerNode({
      kind: "effect",
      name,
      stage: "afterPatch",
      description: effectConfig.description,
      ...(effectConfig.dependsOn !== undefined ? { dependsOn: [...effectConfig.dependsOn] } : {}),
      run: async (input) => {
        const result = await effectConfig.run(input.state, input.context, toProgramRuntime(input), input.step);
        return programStatePatchToWorkflowPatch(result);
      },
    });
  }

  function registerCommand(
    name: string,
    commandConfig: ProgramCommandConfig<TState, TConnectors>,
  ): void {
    assertProgramNodeInvariants(name, commandConfig, `${label} command`);
    registerNode({
      kind: "effect",
      name,
      stage: "afterPatch",
      description: commandConfig.description,
      when: async (input) => commandConfig.when(input.state, input.context, toProgramRuntime(input)),
      run: async (input) => {
        const result = await commandConfig.run(input.state, input.context, toProgramRuntime(input), input.step);
        return programStatePatchToWorkflowPatch(result);
      },
    });
  }

  function registerLoop<TLoopState extends object>(
    name: string,
    loopConfig: ProgramLoopConfig<TState, TLoopState>,
  ): ProgramLoop<TState, TConnectors, TLoopState> {
    assertProgramNodeInvariants(name, loopConfig, `${label} loop`);
    assertProgramLoopConfigInvariants(loopConfig, `${label} loop ${name}`);
    assertProgramEffectDependencies(loopConfig.dependsOn, `${label} loop ${name} dependsOn`);
    const effects: Array<{
      name: string;
      description: string;
      dependsOn?: readonly string[];
      run: (
        input: WorkflowRuntimeInput<TState, TConnectors>,
        loop: WorkflowLoopRuntime<object>,
      ) => MaybePromise<WorkflowPatch<TState> | void>;
    }> = [];

    registerNode({
      kind: "loop",
      name,
      stage: "afterPatch",
      description: loopConfig.description,
      ...(loopConfig.dependsOn !== undefined ? { dependsOn: [...loopConfig.dependsOn] } : {}),
      maxRuns: loopConfig.maxRuns,
      instruction: loopConfig.instruction,
      ...(loopConfig.model !== undefined ? { model: loopConfig.model } : {}),
      stateSchema: loopConfig.stateSchema,
      effects,
    });

    function loopEffect(effectName: string, effectConfig: ProgramLoopEffectConfig<TState, TConnectors, TLoopState>): void;
    function loopEffect(
      effectName: string,
      dependsOn: ProgramLoopEffectDependencies,
      effectConfig: ProgramLoopEffectConfig<TState, TConnectors, TLoopState>,
    ): void;
    function loopEffect(
      effectName: string,
      dependenciesOrConfig:
        | ProgramLoopEffectDependencies
        | ProgramLoopEffectConfig<TState, TConnectors, TLoopState>,
      maybeConfig?: ProgramLoopEffectConfig<TState, TConnectors, TLoopState>,
    ): void {
      const normalized = normalizeLoopEffectConfig(dependenciesOrConfig, maybeConfig);
      assertProgramNodeInvariants(effectName, normalized, `${label} loop ${name} effect`);
      assertProgramLoopEffectDependencies(
        normalized.dependsOn,
        `${label} loop ${name} effect ${effectName} dependsOn`,
      );
      if (effects.some((existing) => existing.name === effectName)) {
        throw new Error(`Duplicate workflow loop effect: ${name}.${effectName}`);
      }
      effects.push({
        name: effectName,
        description: normalized.description,
        ...(normalized.dependsOn !== undefined ? { dependsOn: [...normalized.dependsOn] } : {}),
        run: async (input, loopRuntime) => {
          const result = await normalized.run(
            input.state,
            input.context,
            {
              ...toProgramRuntime(input),
              loop: loopRuntime as WorkflowLoopRuntime<TLoopState>,
            },
            input.step,
          );
          return programStatePatchToWorkflowPatch(result);
        },
      });
    }

    return { effect: loopEffect };
  }

  function registerNode(node: WorkflowNode<TState, TConnectors>): void {
    assertProgramNodeStage(node, `${label} node`);
    if (nodes.some((existing) => existing.name === node.name)) {
      throw new Error(`Duplicate workflow node: ${node.name}`);
    }
    nodes.push(node);
  }
}

function workflowMetadata<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  config: ProgramWorkflowConfig<TState, TConnectors> | ProgramWorkflowTemplateConfig<TState, TConnectors>,
): WorkflowDefinitionMetadata | undefined {
  if (!("id" in config)) return undefined;

  return {
    id: config.id,
    version: config.version,
    description: config.description,
    routing: config.routing,
  };
}

function toProgramRuntime<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  input: WorkflowRuntimeInput<TState, TConnectors>,
): ProgramRuntime {
  return {
    session: input.session,
    turn: input.turn,
    step: input.step,
  };
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

function normalizeLoopEffectConfig<
  TState extends object,
  TConnectors extends ConnectorCatalog,
  TLoopState extends object,
>(
  dependenciesOrConfig:
    | ProgramLoopEffectDependencies
    | ProgramLoopEffectConfig<TState, TConnectors, TLoopState>,
  maybeConfig?: ProgramLoopEffectConfig<TState, TConnectors, TLoopState>,
): ProgramLoopEffectConfig<TState, TConnectors, TLoopState> {
  if (isLoopEffectDependencies(dependenciesOrConfig)) {
    if (!maybeConfig) {
      throw new Error("Workflow loop effect dependencies must be followed by an effect config");
    }

    return {
      ...maybeConfig,
      dependsOn: dependenciesOrConfig,
    };
  }

  return dependenciesOrConfig;
}

function isLoopEffectDependencies<
  TState extends object,
  TConnectors extends ConnectorCatalog,
  TLoopState extends object,
>(
  value:
    | ProgramLoopEffectDependencies
    | ProgramLoopEffectConfig<TState, TConnectors, TLoopState>,
): value is ProgramLoopEffectDependencies {
  return Array.isArray(value);
}

function programStatePatchToWorkflowPatch<TState extends object>(
  result: ProgramStatePatch<TState> | void,
): WorkflowPatch<TState> | undefined {
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
