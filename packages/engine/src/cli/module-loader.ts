import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createConnectorRegistry,
  ConnectorRegistry,
  defineWorkflowDefinitionFromTemplate,
  type AnyConnectorTool,
  type WorkflowDefinitionMetadata,
  type WorkflowDefinitionTemplate,
} from "@pac/workflow";
import { z } from "zod";
import type { WorkflowDefinitionInput } from "../index.js";
import {
  functionSchema,
  parserSchema,
  zodTypeSchema,
} from "../utils/schema-boundary.js";

export interface WorkflowFileInput {
  path: string;
  metadata?: WorkflowDefinitionMetadata | undefined;
}

/**
 * Loads a workflow definition from a local ESM module.
 * Input: path to a module exporting `default` or `workflow`.
 * Output: workflow definition input accepted by WorkflowEngine.
 * Boundary: dynamic module exports are unknown, so this uses a schema-backed CLI boundary check.
 */
export async function loadWorkflow(path: string): Promise<WorkflowDefinitionInput> {
  const workflows = await loadWorkflows(path);
  const [workflow] = workflows;
  if (!workflow || workflows.length !== 1) {
    throw new Error(`Module must export exactly one workflow definition: ${path}`);
  }
  return workflow;
}

/**
 * Loads workflow definitions from explicit per-workflow artifact paths.
 * Input: paths or manifest-derived files with optional metadata.
 * Output: one validated workflow definition per file, preserving manifest order.
 * Boundary: manifest metadata overrides full definitions and is required for metadata-less templates.
 */
export async function loadWorkflowFiles(files: readonly (string | WorkflowFileInput)[]): Promise<WorkflowDefinitionInput[]> {
  return Promise.all(files.map((file) => loadWorkflowFile(file)));
}

/**
 * Loads one or more workflow definitions from a local ESM module.
 * Input: path to a module exporting `default`, `workflow`, or `workflows`.
 * Output: workflow definitions accepted by WorkflowEngine.
 * Boundary: each exported workflow is validated independently at the CLI boundary.
 */
export async function loadWorkflows(path: string): Promise<WorkflowDefinitionInput[]> {
  const mod = await importModule(path);
  const exported = mod.default ?? mod.workflows ?? mod.workflow;
  const workflows = z.array(workflowExportSchema()).safeParse(exported);
  if (workflows.success) {
    if (workflows.data.length === 0) {
      throw new Error(`Module does not export any workflow definitions: ${path}`);
    }
    return workflows.data.map((workflow) => workflow as unknown as WorkflowDefinitionInput);
  }

  if (!workflowExportSchema().safeParse(exported).success) {
    throw new Error(`Module does not export workflow definition(s): ${path}`);
  }

  return [exported as WorkflowDefinitionInput];
}

async function loadWorkflowFile(file: string | WorkflowFileInput): Promise<WorkflowDefinitionInput> {
  if (typeof file === "string") return loadWorkflow(file);

  const mod = await importModule(file.path);
  const exported = mod.default ?? mod.workflow;
  const workflow = workflowExportSchema().safeParse(exported);
  if (workflow.success) {
    const definition = workflow.data as unknown as WorkflowDefinitionInput;
    return file.metadata ? { ...definition, ...file.metadata } : definition;
  }

  if (file.metadata) {
    const template = workflowTemplateExportSchema().safeParse(exported);
    if (template.success) {
      return defineWorkflowDefinitionFromTemplate(
        file.metadata,
        template.data as unknown as WorkflowDefinitionTemplate,
      ) as WorkflowDefinitionInput;
    }
  }

  throw new Error(`Workflow file must export exactly one workflow definition or manifest-backed template: ${file.path}`);
}

/**
 * Loads connector tools from explicit per-connector config files and creates one registry.
 * Input: paths derived from an agent manifest's `connectors` file-name entries.
 * Output: a connector registry containing all loaded tools.
 * Boundary: connector files export loader functions; registry construction and duplicate-id validation stay in the engine.
 */
export async function loadConnectorFiles(paths: readonly string[]): Promise<ConnectorRegistry> {
  if (paths.length === 0) return createConnectorRegistry();

  const toolGroups = await Promise.all(paths.map((path) => loadConnectorTools(path)));
  return createConnectorRegistry(toolGroups.flat());
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

  if (typeof exported === "function") {
    const tools = connectorToolsExportSchema().parse(await exported());
    return createConnectorRegistry(tools);
  }

  const tools = connectorToolsExportSchema().safeParse(exported);
  if (tools.success) {
    return createConnectorRegistry(tools.data);
  }

  throw new Error(`Module does not export a connector registry, connector tool array, or connector loader function: ${path}`);
}

async function loadConnectorTools(path: string): Promise<AnyConnectorTool[]> {
  const mod = await importModule(path);
  const exported = mod.default;
  if (typeof exported !== "function") {
    throw new Error(`Connector file must default export a connector loader function: ${path}`);
  }

  return connectorToolsExportSchema().parse(await exported());
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

function workflowTemplateExportSchema() {
  return z.object({
    __pacWorkflowTemplate: z.literal(true),
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
  return z
    .object({
      kind: z.enum(["prefetch", "effect"]),
      name: z.string(),
      stage: z.enum(["beforePatch", "withPatch", "afterPatch"]),
      progress: z.string().optional(),
      description: z.string(),
      when: functionSchema().optional(),
      run: functionSchema(),
    })
    .superRefine((node, context) => {
      if (node.kind === "prefetch" && !node.progress) {
        context.addIssue({
          code: "custom",
          message: "prefetch node progress must be a non-empty string",
          path: ["progress"],
        });
      }
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
