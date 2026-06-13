import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnectorRegistry, ConnectorRegistry, type AnyConnectorTool } from "@pac/workflow";
import { z } from "zod";
import type { WorkflowDefinitionInput } from "../index.js";
import {
  functionSchema,
  parserSchema,
  zodTypeSchema,
} from "../utils/schema-boundary.js";

/**
 * Loads a workflow definition from a local ESM module.
 * Input: path to a module exporting `default` or `workflow`.
 * Output: workflow definition input accepted by WorkflowEngine.
 * Boundary: dynamic module exports are unknown, so this uses a schema-backed CLI boundary check.
 */
export async function loadWorkflow(path: string): Promise<WorkflowDefinitionInput> {
  const mod = await importModule(path);
  const workflow = mod.default ?? mod.workflow;

  if (!workflowExportSchema().safeParse(workflow).success) {
    throw new Error(`Module does not export a workflow definition: ${path}`);
  }

  return workflow as WorkflowDefinitionInput;
}

/**
 * Loads optional connector tooling from a local ESM module.
 * Input: optional path to a connector registry or connector tool array module.
 * Output: connector registry used by workflow runtime dependencies.
 * Boundary: connector contract validation is delegated to createConnectorRegistry and runtime calls.
 */
export async function loadConnectors(path: string | undefined): Promise<ConnectorRegistry> {
  if (!path) return createConnectorRegistry();

  const mod = await importModule(path);
  const exported = mod.default ?? mod.connectors ?? mod.connectorRegistry ?? mod.connectorTools;

  if (exported instanceof ConnectorRegistry) {
    return exported;
  }

  const tools = connectorToolsExportSchema().safeParse(exported);
  if (tools.success) {
    return createConnectorRegistry(tools.data);
  }

  throw new Error(`Module does not export a connector registry or connector tool array: ${path}`);
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`File does not exist: ${absolute}`);
  }

  return import(pathToFileURL(absolute).href) as Promise<Record<string, unknown>>;
}

function workflowExportSchema() {
  return z.object({
    id: z.string(),
    version: z.string(),
    description: z.string(),
    routing: z.object({
      examples: z.array(z.string()),
      entities: z.array(z.string()),
      neighbors: z.array(z.string()),
      thresholds: z.record(z.string(), z.number()),
    }),
    stateSchema: parserSchema(),
    state: z.record(z.string(), z.unknown()),
    nodes: z.array(workflowNodeExportSchema()),
    patch: z.object({
      schema: parserSchema(),
      instruction: z.string(),
      model: z.string().optional(),
      progress: z.string().optional(),
    }),
    invalidation: z.record(z.string(), z.array(z.string())),
    render: z.union([functionSchema(), renderPolicyExportSchema()]),
  });
}

function workflowNodeExportSchema() {
  return z.object({
    kind: z.enum(["prefetch", "effect"]),
    name: z.string(),
    stage: z.enum(["beforePatch", "withPatch", "afterPatch"]),
    progress: z.string(),
    description: z.string(),
    when: functionSchema().optional(),
    run: functionSchema(),
  });
}

function renderPolicyExportSchema() {
  return z.object({
    name: z.string(),
    instruction: z.string(),
    progress: z.string(),
  });
}

function connectorToolsExportSchema() {
  return z.array(connectorToolExportSchema());
}

function connectorToolExportSchema() {
  return z.object({
    id: z.string(),
    description: z.string().optional(),
    inputSchema: zodTypeSchema(),
    outputSchema: zodTypeSchema(),
    execute: functionSchema<AnyConnectorTool["execute"]>(),
  });
}
