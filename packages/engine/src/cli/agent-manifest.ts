import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  resolve,
} from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const AGENT_MANIFEST_FILENAME = "agent.yaml";

export interface AgentTurn {
  message: string;
  expect?: Record<string, unknown> | undefined;
}

export interface AgentCase {
  id: string;
  description: string;
  workflowIds?: string[] | undefined;
  route: "active" | "local";
  userId?: string | undefined;
  turns: AgentTurn[];
}

export interface AgentManifest {
  manifestPath: string;
  directory: string;
  connectorFiles: AgentConnectorFile[];
  workflowFiles: AgentWorkflowFile[];
  workflowIds: string[];
  cases: AgentCase[];
}

export interface AgentConnectorFile {
  name: string;
  path: string;
}

export interface AgentWorkflowFile {
  name: string;
  id: string;
  path: string;
}

export type CliWorkflowSource =
  | {
      kind: "module";
      workflowPath: string;
    }
  | {
      kind: "agent";
      connectorFiles: AgentConnectorFile[];
      workflowFiles: AgentWorkflowFile[];
      manifest: AgentManifest;
    };

const AgentTurnSchema = z.object({
  message: z.string().min(1),
  expect: z.record(z.string(), z.unknown()).optional(),
});

const AgentCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  workflowIds: z.array(z.string().min(1)).min(1).optional(),
  route: z.enum(["active", "local"]).default("active"),
  userId: z.string().min(1).optional(),
  turns: z.array(AgentTurnSchema).min(1),
});

const WorkflowNameSchema = z.string().min(1).regex(
  /^[A-Za-z0-9_-]+$/,
  "workflow names must be file-safe and match workflows/<name>.workflow.ts",
);

const ConnectorNameSchema = z.string().min(1).regex(
  /^[A-Za-z0-9_-]+$/,
  "connector names must be file-safe and match connectors/<name>.ts",
);

const AgentWorkflowSchema = z.object({
  id: z.string().min(1),
}).passthrough();

const AgentManifestFileSchema = z
  .object({
    connectors: z.array(ConnectorNameSchema).default([]),
    workflows: z.record(WorkflowNameSchema, AgentWorkflowSchema),
    cases: z.array(AgentCaseSchema).default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = Object.values(manifest.workflows).map((workflow) => workflow.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    for (const id of [...new Set(duplicateIds)]) {
      context.addIssue({
        code: "custom",
        message: `duplicate workflow id: ${id}`,
        path: ["workflows"],
      });
    }
  });

/**
 * Resolves a CLI workflow argument without changing explicit module behavior.
 * Input: a workflow module path, an agent directory, or an agent.yaml path.
 * Output: explicit module path or manifest-derived workflow file paths plus optional agent case metadata.
 * Boundary: only directory/manifest discovery happens here; module export validation stays in module-loader.
 */
export function resolveCliWorkflowSource(inputPath: string): CliWorkflowSource {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath)) {
    return {
      kind: "module",
      workflowPath: inputPath,
    };
  }

  const stats = statSync(absolutePath);
  if (stats.isDirectory()) {
    return agentSourceFromManifest(resolve(absolutePath, AGENT_MANIFEST_FILENAME));
  }

  if (stats.isFile() && basename(absolutePath) === AGENT_MANIFEST_FILENAME) {
    return agentSourceFromManifest(absolutePath);
  }

  return {
    kind: "module",
    workflowPath: inputPath,
  };
}

function agentSourceFromManifest(manifestPath: string): CliWorkflowSource {
  const manifest = loadAgentManifest(manifestPath);
  const source: CliWorkflowSource = {
    kind: "agent",
    connectorFiles: manifest.connectorFiles,
    workflowFiles: manifest.workflowFiles,
    manifest,
  };

  return source;
}

/**
 * Reads an agent manifest from disk.
 * Input: absolute or relative path to agent.yaml.
 * Output: normalized workflow artifact paths and case descriptors relative to the manifest directory.
 * Boundary: manifest fields are schema-validated; executable modules are imported later.
 */
export function loadAgentManifest(manifestPath: string): AgentManifest {
  const absolutePath = resolve(manifestPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Agent manifest does not exist: ${absolutePath}`);
  }

  const directory = dirname(absolutePath);
  const parsed = AgentManifestFileSchema.parse(
    YAML.parse(readFileSync(absolutePath, "utf8")),
  );
  const manifest: AgentManifest = {
    manifestPath: absolutePath,
    directory,
    connectorFiles: connectorFilesFromManifest(directory, parsed),
    workflowFiles: workflowFilesFromManifest(directory, parsed),
    workflowIds: workflowIdsFromManifest(parsed),
    cases: parsed.cases,
  };

  return manifest;
}

function workflowIdsFromManifest(
  manifest: z.infer<typeof AgentManifestFileSchema>,
): string[] {
  return Object.values(manifest.workflows).map((workflow) => workflow.id);
}

function workflowFilesFromManifest(
  directory: string,
  manifest: z.infer<typeof AgentManifestFileSchema>,
): AgentWorkflowFile[] {
  return Object.entries(manifest.workflows).map(([name, workflow]) => ({
    name,
    id: workflow.id,
    path: resolve(directory, "workflows", `${name}.workflow.ts`),
  }));
}

function connectorFilesFromManifest(
  directory: string,
  manifest: z.infer<typeof AgentManifestFileSchema>,
): AgentConnectorFile[] {
  return manifest.connectors.map((name) => ({
    name,
    path: resolve(directory, "connectors", `${name}.ts`),
  }));
}
