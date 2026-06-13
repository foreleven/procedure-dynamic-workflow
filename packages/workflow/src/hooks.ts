import type { z } from "zod";
import type { PatchPolicy } from "./builders.js";
import type { ConnectorCatalog } from "./connectors.js";
import type { MaybePromise, RoutingProfile, WorkflowId } from "./common.js";
import type { RenderCase, WorkflowActionInput } from "./actions.js";
import { workflowActions } from "./actions.js";
import { assertHookNodeInvariants } from "./definition/hook-guards.js";
import type {
  RenderFunction,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeStage,
  WorkflowPatch,
} from "./workflow.js";
import { defineWorkflowDefinition } from "./workflow.js";

export interface WorkflowNodeOptions<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  stage?: WorkflowNodeStage;
  progress?: string;
  description?: string;
  when?: (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<boolean>;
}

export type PrefetchLoader<
  TState extends object,
  TConnectors extends ConnectorCatalog,
> = (
  input: WorkflowActionInput<TState, TConnectors>,
) => MaybePromise<Record<string, MaybePromise<unknown>>>;

export type StateResolver<
  TState extends object,
  TConnectors extends ConnectorCatalog,
  K extends Exclude<keyof TState & string, "messages">,
> = (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<TState[K] | undefined>;

export type ContextResolver<
  TState extends object,
  TConnectors extends ConnectorCatalog,
> = (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<unknown>;

export type EffectRunner<
  TState extends object,
  TConnectors extends ConnectorCatalog,
> = (
  input: WorkflowActionInput<TState, TConnectors>,
) => MaybePromise<WorkflowPatch<TState> | void>;

export interface WorkflowHooks<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  usePrefetch(
    name: string,
    load: PrefetchLoader<TState, TConnectors>,
    options?: WorkflowNodeOptions<TState, TConnectors>,
  ): void;

  useContext(
    name: string,
    keys: string[],
    options?: WorkflowNodeOptions<TState, TConnectors>,
  ): void;

  useContextEffect(
    name: string,
    key: string,
    resolve: ContextResolver<TState, TConnectors>,
    options?: WorkflowNodeOptions<TState, TConnectors>,
  ): void;

  useStateEffect<K extends Exclude<keyof TState & string, "messages">>(
    name: string,
    field: K,
    resolve: StateResolver<TState, TConnectors, K>,
    options?: WorkflowNodeOptions<TState, TConnectors>,
  ): void;

  useEffect(
    name: string,
    run: EffectRunner<TState, TConnectors>,
    options?: WorkflowNodeOptions<TState, TConnectors>,
  ): void;

  useRender(
    cases: Array<RenderCase<TState, TConnectors>>,
    fallback: RenderCase<TState, TConnectors>,
  ): void;

  useRenderFunction(render: RenderFunction<TState, TConnectors>): void;
}

export interface HookWorkflowConfig<
  TStateSchema extends z.ZodType<object>,
  TPatch,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  id: WorkflowId;
  version: string;
  description: string;
  routing: RoutingProfile;
  stateSchema: TStateSchema;
  state: z.infer<TStateSchema>;
  patch: PatchPolicy<TPatch>;
  invalidation: Partial<Record<keyof z.infer<TStateSchema> & string, Array<keyof z.infer<TStateSchema> & string>>>;
  setup(hooks: WorkflowHooks<z.infer<TStateSchema>, TConnectors>): void;
}

export function defineWorkflowHooks<
  TStateSchema extends z.ZodType<object>,
  TPatch,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  config: HookWorkflowConfig<TStateSchema, TPatch, TConnectors>,
): WorkflowDefinition<z.infer<TStateSchema>, TPatch, TConnectors> {
  type TState = z.infer<TStateSchema>;

  const action = workflowActions<TState, TConnectors>();
  const nodes: Array<WorkflowNode<TState, TConnectors>> = [];
  let render: RenderFunction<TState, TConnectors> | undefined;

  const hooks: WorkflowHooks<TState, TConnectors> = {
    usePrefetch(name, load, options) {
      registerNode(nodes, {
        kind: "prefetch",
        name,
        ...nodeMetadata(name, options),
        stage: options?.stage ?? "beforePatch",
        ...(options?.when ? { when: options.when } : {}),
        run: action.prefetch(load),
      });
    },

    useContext(name, keys, options) {
      registerNode(nodes, {
        kind: "effect",
        name,
        ...nodeMetadata(name, options),
        stage: options?.stage ?? "afterPatch",
        ...(options?.when ? { when: options.when } : {}),
        run: action.hydrateContext(keys),
      });
    },

    useContextEffect(name, key, resolve, options) {
      registerNode(nodes, {
        kind: "effect",
        name,
        ...nodeMetadata(name, options),
        stage: options?.stage ?? "afterPatch",
        ...(options?.when ? { when: options.when } : {}),
        run: action.setContext(key, resolve),
      });
    },

    useStateEffect(name, field, resolve, options) {
      registerNode(nodes, {
        kind: "effect",
        name,
        ...nodeMetadata(name, options),
        stage: options?.stage ?? "afterPatch",
        ...(options?.when ? { when: options.when } : {}),
        run: action.setState(field, resolve),
      });
    },

    useEffect(name, run, options) {
      registerNode(nodes, {
        kind: "effect",
        name,
        ...nodeMetadata(name, options),
        stage: options?.stage ?? "afterPatch",
        ...(options?.when ? { when: options.when } : {}),
        run: action.effect(run),
      });
    },

    useRender(cases, fallback) {
      setRender(action.render(cases, fallback));
    },

    useRenderFunction(nextRender) {
      setRender(nextRender);
    },
  };

  config.setup(hooks);

  if (!render) {
    throw new Error(`Workflow ${config.id} did not register render`);
  }

  const definition = {
    id: config.id,
    version: config.version,
    description: config.description,
    routing: config.routing,
    stateSchema: config.stateSchema,
    state: config.state,
    nodes,
    patch: config.patch,
    invalidation: config.invalidation,
    render,
  } as WorkflowDefinition<TState, TPatch, TConnectors> & {
    stateSchema: TStateSchema;
  };

  return defineWorkflowDefinition(definition);

  function setRender(nextRender: RenderFunction<TState, TConnectors>): void {
    if (render) {
      throw new Error(`Workflow ${config.id} registered render more than once`);
    }

    render = nextRender;
  }
}

function registerNode<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  nodes: Array<WorkflowNode<TState, TConnectors>>,
  node: WorkflowNode<TState, TConnectors>,
): void {
  if (nodes.some((existing) => existing.name === node.name)) {
    throw new Error(`Duplicate workflow node: ${node.name}`);
  }

  nodes.push(node);
}

function nodeMetadata<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  name: string,
  options: WorkflowNodeOptions<TState, TConnectors> | undefined,
): { progress: string; description: string } {
  assertHookNodeInvariants(name, options);
  return {
    progress: options?.progress ?? name,
    description: options?.description ?? `Legacy hook node ${name}`,
  };
}

export type { WorkflowActionInput };
