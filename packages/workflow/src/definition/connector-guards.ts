import { z } from "zod";
import type {
  AnyConnectorRef,
  AnyConnectorTool,
  ConnectorCatalog,
} from "../connectors.js";
import {
  functionSchema,
  nonEmptyString,
  parseSchema,
  zodSchema,
} from "../utils/schema.js";

/**
 * Asserts connector contract metadata at public definition and registry boundaries.
 * Input: caller supplied connector refs, tools, or catalogs.
 * Output: throws stable definition-time errors before connector execution.
 * Boundary: connector input/output payloads remain owned by each declared Zod schema.
 */
export function validateConnectorRef(ref: unknown, label: string): asserts ref is AnyConnectorRef {
  parseSchema(connectorRefSchema(label), ref);
}

export function validateConnectorCatalogObject(value: unknown): asserts value is ConnectorCatalog {
  parseSchema(z.record(z.string(), z.unknown(), { message: "Connector catalog must be an object" }), value);
}

export function validateConnectorTool(tool: unknown): asserts tool is AnyConnectorTool {
  validateConnectorRef(tool, `Connector tool ${connectorIdForLabel(tool)}`);
  parseSchema(
    z.object({
      execute: functionSchema(`Connector tool ${tool.id} execute must be a function`),
    }),
    tool,
  );
}

function connectorRefSchema(label: string) {
  return z.object(
    {
      id: nonEmptyString(`${label} id`),
      description: nonEmptyString(`${label} description`).optional(),
      inputSchema: zodSchema(`${label} inputSchema`),
      outputSchema: zodSchema(`${label} outputSchema`),
    },
    { message: `${label} must be an object` },
  );
}

function connectorIdForLabel(value: unknown): string {
  const parsed = z.object({ id: z.unknown() }).safeParse(value);
  return parsed.success ? String(parsed.data.id) : "unknown";
}
