import { z } from "zod";
import type { MaybePromise } from "./common.js";

export interface ConnectorRef<TId extends string = string, TInput = unknown, TOutput = unknown> {
  id: TId;
  description?: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}

export interface ConnectorTool<TId extends string = string, TInput = unknown, TOutput = unknown>
  extends ConnectorRef<TId, TInput, TOutput> {
  execute: (input: TInput) => MaybePromise<TOutput>;
}

export type AnyConnectorRef = ConnectorRef<string, any, any>;
export type AnyConnectorTool = ConnectorTool<string, any, any>;
export type ConnectorCatalog = Record<string, AnyConnectorRef>;

export type ConnectorInput<TConnector> =
  TConnector extends ConnectorRef<string, infer TInput, any> ? TInput : never;

export type ConnectorOutput<TConnector> =
  TConnector extends ConnectorRef<string, any, infer TOutput> ? TOutput : never;

export type ConnectorId<TCatalog extends ConnectorCatalog> = keyof TCatalog & string;

export type ConnectorCatalogFromTools<TTools extends readonly AnyConnectorTool[]> = {
  [TTool in TTools[number] as TTool["id"]]: ConnectorRef<TTool["id"], ConnectorInput<TTool>, ConnectorOutput<TTool>>;
};

export function defineConnectorRef<
  const TId extends string,
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(config: {
  id: TId;
  description?: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
}): ConnectorRef<TId, z.infer<TInputSchema>, z.infer<TOutputSchema>> {
  return config as ConnectorRef<TId, z.infer<TInputSchema>, z.infer<TOutputSchema>>;
}

export function defineConnectorCatalog<const TCatalog extends ConnectorCatalog>(catalog: TCatalog): TCatalog {
  for (const [id, ref] of Object.entries(catalog)) {
    if (id !== ref.id) {
      throw new Error(`Connector catalog key must match connector id: ${id} !== ${ref.id}`);
    }
  }

  return catalog;
}

export function defineConnectorTool<TId extends string, TInput, TOutput>(
  ref: ConnectorRef<TId, TInput, TOutput>,
  execute: (input: TInput) => MaybePromise<TOutput>,
): ConnectorTool<TId, TInput, TOutput> {
  return {
    ...ref,
    execute,
  };
}

export class ConnectorRegistry<TCatalog extends ConnectorCatalog = ConnectorCatalog> {
  private readonly tools = new Map<string, AnyConnectorTool>();
  private readonly catalog: ConnectorCatalog;

  constructor(tools: readonly AnyConnectorTool[], catalog: TCatalog = catalogFromTools(tools) as TCatalog) {
    this.catalog = catalog;

    for (const tool of tools) {
      if (this.tools.has(tool.id)) {
        throw new Error(`Duplicate connector tool: ${tool.id}`);
      }

      this.tools.set(tool.id, tool);
    }

    for (const id of Object.keys(this.catalog)) {
      if (!this.tools.has(id)) {
        throw new Error(`Missing connector tool for catalog entry: ${id}`);
      }
    }
  }

  list(): AnyConnectorTool[] {
    return [...this.tools.values()];
  }

  has(id: ConnectorId<TCatalog> | string): boolean {
    return this.tools.has(id);
  }

  async call<TId extends ConnectorId<TCatalog>>(
    id: TId,
    input: ConnectorInput<TCatalog[TId]>,
  ): Promise<ConnectorOutput<TCatalog[TId]>> {
    const tool = this.requireTool(id);
    const ref = this.catalog[id] ?? tool;
    const parsedInput = ref.inputSchema.parse(input);
    const output = await tool.execute(parsedInput);
    return ref.outputSchema.parse(output);
  }

  private requireTool(id: string): AnyConnectorTool {
    const tool = this.tools.get(id);
    if (!tool) {
      throw new Error(`Missing connector tool: ${id}`);
    }

    return tool;
  }
}

export function createConnectorRegistry<
  const TTools extends readonly AnyConnectorTool[] = readonly AnyConnectorTool[],
  TCatalog extends ConnectorCatalog = ConnectorCatalogFromTools<TTools>,
>(tools: TTools = [] as unknown as TTools, catalog?: TCatalog): ConnectorRegistry<TCatalog> {
  return new ConnectorRegistry(tools, catalog);
}

function catalogFromTools(tools: readonly AnyConnectorTool[]): ConnectorCatalog {
  return Object.fromEntries(tools.map((tool) => [tool.id, tool]));
}
