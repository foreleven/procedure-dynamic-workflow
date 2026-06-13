import { z } from "zod";
import type { MaybePromise } from "./common.js";
import {
  validateConnectorCatalogObject,
  validateConnectorRef,
  validateConnectorTool,
} from "./definition/connector-guards.js";
import { parseSchema } from "./utils/schema.js";

export interface ConnectorRef<TId extends string = string, TInput = unknown, TOutput = unknown> {
  id: TId;
  description?: string | undefined;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}

export interface ConnectorTool<TId extends string = string, TInput = unknown, TOutput = unknown>
  extends ConnectorRef<TId, TInput, TOutput> {
  execute(input: TInput): MaybePromise<TOutput>;
}

export type AnyConnectorRef = ConnectorRef<string, unknown, unknown>;
export type AnyConnectorTool = ConnectorTool<string, unknown, unknown>;
export type ConnectorCatalog = Record<string, AnyConnectorRef>;

export type ConnectorInput<TConnector> =
  TConnector extends ConnectorRef<string, infer TInput, unknown> ? TInput : never;

export type ConnectorOutput<TConnector> =
  TConnector extends ConnectorRef<string, unknown, infer TOutput> ? TOutput : never;

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
  description?: string | undefined;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
}): ConnectorRef<TId, z.infer<TInputSchema>, z.infer<TOutputSchema>> {
  validateConnectorRef(config, "Connector ref");
  return config as ConnectorRef<TId, z.infer<TInputSchema>, z.infer<TOutputSchema>>;
}

export function defineConnectorCatalog<const TCatalog extends ConnectorCatalog>(catalog: TCatalog): TCatalog {
  validateConnectorCatalogObject(catalog);
  for (const [id, ref] of Object.entries(catalog)) {
    validateConnectorRef(ref, `Connector catalog entry ${id}`);
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
  validateConnectorRef(ref, "Connector ref");
  validateConnectorTool({ ...ref, execute });

  return {
    ...ref,
    execute,
  };
}

export class ConnectorRegistry<TCatalog extends ConnectorCatalog = ConnectorCatalog> {
  private readonly tools = new Map<string, AnyConnectorTool>();
  private readonly catalog: TCatalog;

  constructor(tools: readonly AnyConnectorTool[], catalog?: TCatalog) {
    parseSchema(z.array(z.unknown(), { message: "ConnectorRegistry tools must be an array" }), tools);
    const effectiveCatalog = catalog ?? catalogFromTools(tools);
    validateConnectorCatalogObject(effectiveCatalog);
    this.catalog = effectiveCatalog as TCatalog;

    for (const tool of tools) {
      validateConnectorTool(tool);
      if (this.tools.has(tool.id)) {
        throw new Error(`Duplicate connector tool: ${tool.id}`);
      }

      this.tools.set(tool.id, tool);
    }

    for (const [id, ref] of Object.entries(this.catalog)) {
      validateConnectorRef(ref, `Connector catalog entry ${id}`);
      if (id !== ref.id) {
        throw new Error(`Connector catalog key must match connector id: ${id} !== ${ref.id}`);
      }

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
    const ref = this.requireCatalogRef(id);
    const parsedInput = ref.inputSchema.parse(input);
    const output = await tool.execute(parsedInput);
    return parseConnectorOutput(ref, output);
  }

  /**
   * Returns the catalog reference validated during registry construction.
   * Input: connector id from the registry catalog.
   * Output: connector-specific reference for schema parsing.
   * Boundary: missing refs indicate an invalid registry invariant, not a user input error.
   */
  private requireCatalogRef<TId extends ConnectorId<TCatalog>>(id: TId): TCatalog[TId] {
    const ref = this.catalog[id];
    if (!ref) {
      throw new Error(`Missing connector catalog entry: ${id}`);
    }

    return ref;
  }

  private requireTool(id: string): AnyConnectorTool {
    const tool = this.tools.get(id);
    if (!tool) {
      throw new Error(`Missing connector tool: ${id}`);
    }

    return tool;
  }
}

/**
 * Creates a schema-validating connector registry while preserving catalog inference from tool ids.
 * Input: optional connector tools and an optional explicit connector catalog.
 * Output: a connector registry whose call signatures use the inferred or supplied catalog.
 * Boundary: connector implementations are still responsible for external side effects.
 */
export function createConnectorRegistry(): ConnectorRegistry<ConnectorCatalog>;
export function createConnectorRegistry<
  const TTools extends readonly AnyConnectorTool[],
  TCatalog extends ConnectorCatalog = ConnectorCatalogFromTools<TTools>,
>(tools: TTools, catalog?: TCatalog): ConnectorRegistry<TCatalog>;
export function createConnectorRegistry(
  tools: readonly AnyConnectorTool[] = [],
  catalog?: ConnectorCatalog,
): ConnectorRegistry<ConnectorCatalog> {
  return new ConnectorRegistry(tools, catalog);
}

function catalogFromTools(tools: readonly AnyConnectorTool[]): ConnectorCatalog {
  return Object.fromEntries(tools.map((tool) => [tool.id, tool]));
}

/**
 * Parses connector output through the catalog schema while preserving the connector-specific output type.
 * Input: a validated connector reference and raw tool output.
 * Output: schema-validated connector output.
 * Boundary: this narrows TypeScript's erased indexed-access type; Zod remains the runtime authority.
 */
function parseConnectorOutput<TConnector extends AnyConnectorRef>(
  ref: TConnector,
  output: unknown,
): ConnectorOutput<TConnector> {
  return ref.outputSchema.parse(output) as ConnectorOutput<TConnector>;
}
