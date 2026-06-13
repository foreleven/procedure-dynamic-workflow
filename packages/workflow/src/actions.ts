import type { MaybePromise } from "./common.js";
import type { ConnectorCatalog } from "./connectors.js";
import { settlePrefetch } from "./runtime/prefetch.js";
import {
  assertActionFunction,
  assertActionNonEmptyString,
  assertActionNonEmptyStringArray,
  assertRenderCase,
  assertRenderCases,
} from "./definition/action-guards.js";
import type {
  PrefetchFunction,
  RenderFunction,
  RenderResponse,
  WorkflowFunction,
  WorkflowPatch,
  WorkflowStatePatch,
  WorkflowRuntimeInput,
} from "./workflow.js";

export type WorkflowActionInput<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = WorkflowRuntimeInput<TState, TConnectors>;

export type WorkflowPredicate<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = (
  input: WorkflowActionInput<TState, TConnectors>,
) => MaybePromise<boolean>;

export type WorkflowText<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> =
  | string
  | ((input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<string>);

export interface RenderCase<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  when?: WorkflowPredicate<TState, TConnectors>;
  text: WorkflowText<TState, TConnectors>;
  data?: (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<unknown>;
}

export function workflowActions<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>() {
  return {
    prefetch: (
      load: (
        input: WorkflowActionInput<TState, TConnectors>,
      ) => MaybePromise<Record<string, MaybePromise<unknown>>>,
    ) => prefetchAction<TState, TConnectors>(load),
    hydrateContext: (keys: string[]) => hydrateContextAction<TState, TConnectors>(keys),
    setState: <K extends Exclude<keyof TState & string, "messages">>(
      field: K,
      resolve: (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<TState[K] | undefined>,
    ) => setStateAction<TState, TConnectors, K>(field, resolve),
    setContext: (
      key: string,
      resolve: (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<unknown>,
    ) => setContextAction<TState, TConnectors>(key, resolve),
    effect: (
      run: (
        input: WorkflowActionInput<TState, TConnectors>,
      ) => MaybePromise<WorkflowPatch<TState> | void>,
    ) => effectAction<TState, TConnectors>(run),
    render: (
      cases: Array<RenderCase<TState, TConnectors>>,
      fallback: RenderCase<TState, TConnectors>,
    ) => renderAction<TState, TConnectors>(cases, fallback),
  };
}

export function prefetchAction<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  load: (
    input: WorkflowActionInput<TState, TConnectors>,
  ) => MaybePromise<Record<string, MaybePromise<unknown>>>,
): PrefetchFunction<TState, TConnectors> {
  assertActionFunction(load, "prefetch load");
  return async (input) => settlePrefetch(await load(input));
}

export function hydrateContextAction<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  keys: string[],
): WorkflowFunction<TState, TConnectors> {
  assertActionNonEmptyStringArray(keys, "hydrateContext keys");
  return async ({ context, prefetch }) => {
    for (const key of keys) {
      const value = prefetch.get(key);
      if (value !== undefined) {
        context.set(key, value);
      }
    }
    return {};
  };
}

export function setStateAction<
  TState extends object,
  TConnectors extends ConnectorCatalog,
  K extends Exclude<keyof TState & string, "messages">,
>(
  field: K,
  resolve: (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<TState[K] | undefined>,
): WorkflowFunction<TState, TConnectors> {
  assertActionNonEmptyString(field, "setState field");
  assertActionFunction(resolve, "setState resolve");
  return async (input) => {
    const value = await resolve(input);
    return value === undefined ? {} : { state: { [field]: value } as WorkflowStatePatch<TState> };
  };
}

export function setContextAction<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  key: string,
  resolve: (input: WorkflowActionInput<TState, TConnectors>) => MaybePromise<unknown>,
): WorkflowFunction<TState, TConnectors> {
  assertActionNonEmptyString(key, "setContext key");
  assertActionFunction(resolve, "setContext resolve");
  return async (input) => {
    const value = await resolve(input);
    if (value !== undefined) {
      input.context.set(key, value);
    }
    return {};
  };
}

export function effectAction<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  run: (
    input: WorkflowActionInput<TState, TConnectors>,
  ) => MaybePromise<WorkflowPatch<TState> | void>,
): WorkflowFunction<TState, TConnectors> {
  assertActionFunction(run, "effect run");
  return async (input) => (await run(input)) ?? {};
}

export function renderAction<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  cases: Array<RenderCase<TState, TConnectors>>,
  fallback: RenderCase<TState, TConnectors>,
): RenderFunction<TState, TConnectors> {
  assertRenderCases(cases, "render cases");
  assertRenderCase(fallback, "render fallback");

  return async (input) => {
    for (const renderCase of cases) {
      if (!renderCase.when || (await renderCase.when(input))) {
        return materializeRenderCase(renderCase, input);
      }
    }

    return materializeRenderCase(fallback, input);
  };
}

async function materializeRenderCase<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  renderCase: RenderCase<TState, TConnectors>,
  input: WorkflowActionInput<TState, TConnectors>,
): Promise<RenderResponse> {
  const text = typeof renderCase.text === "function" ? await renderCase.text(input) : renderCase.text;
  const data = renderCase.data ? await renderCase.data(input) : undefined;
  assertActionNonEmptyString(text, "render text result");

  return data === undefined ? { text } : { text, data };
}
