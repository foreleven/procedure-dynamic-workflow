import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { defineRouting } from "./builders.js";
import type { RoutingProfile, RoutingThresholds, WorkflowId } from "./common.js";

const RoutingThresholdSchema = z.number().finite().min(0).max(1);

const RoutingThresholdsSchema = z.object({
  localAccept: RoutingThresholdSchema.optional(),
  localUncertain: RoutingThresholdSchema.optional(),
  globalAccept: RoutingThresholdSchema.optional(),
});

const WorkflowMetadataSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  routing: z.object({
    examples: z.array(z.string().min(1)),
    entities: z.array(z.string().min(1)),
    neighbors: z.array(z.string().min(1)).default([]),
    thresholds: RoutingThresholdsSchema.optional(),
  }),
});

const WorkflowMetadataFileSchema = z.union([
  WorkflowMetadataSchema,
  z.object({
    workflows: z.record(z.string().min(1), WorkflowMetadataSchema),
  }).passthrough(),
]);

export interface WorkflowMetadata {
  id: WorkflowId;
  version: string;
  description: string;
  routing: RoutingProfile;
}

export function loadWorkflowMetadata(
  relativeTo: string | URL,
  metadataPath = "./agent.yaml",
  workflowName = workflowNameFromPath(filePath(relativeTo)),
): WorkflowMetadata {
  const absolutePath = resolve(dirname(filePath(relativeTo)), metadataPath);
  const parsed = workflowMetadataFromFile(
    WorkflowMetadataFileSchema.parse(YAML.parse(readFileSync(absolutePath, "utf8"))),
    workflowName,
  );
  const routing: Omit<RoutingProfile, "thresholds"> & {
    thresholds?: Partial<RoutingProfile["thresholds"]>;
  } = {
    examples: parsed.routing.examples,
    entities: parsed.routing.entities,
    neighbors: parsed.routing.neighbors,
  };

  if (parsed.routing.thresholds !== undefined) {
    const thresholds: Partial<RoutingThresholds> = {};
    if (parsed.routing.thresholds.localAccept !== undefined) {
      thresholds.localAccept = parsed.routing.thresholds.localAccept;
    }
    if (parsed.routing.thresholds.localUncertain !== undefined) {
      thresholds.localUncertain = parsed.routing.thresholds.localUncertain;
    }
    if (parsed.routing.thresholds.globalAccept !== undefined) {
      thresholds.globalAccept = parsed.routing.thresholds.globalAccept;
    }
    if (Object.keys(thresholds).length > 0) {
      routing.thresholds = thresholds;
    }
  }

  return {
    id: parsed.id,
    version: parsed.version,
    description: parsed.description,
    routing: defineRouting(routing),
  };
}

function workflowMetadataFromFile(
  parsed: z.infer<typeof WorkflowMetadataFileSchema>,
  workflowName: string,
): z.infer<typeof WorkflowMetadataSchema> {
  if ("workflows" in parsed) {
    const metadata = parsed.workflows[workflowName];
    if (!metadata) {
      throw new Error(`No workflow metadata found for ${workflowName}`);
    }
    return metadata;
  }

  return parsed;
}

function workflowNameFromPath(path: string): string {
  const name = basename(path);
  return name
    .replace(/\.workflow\.[cm]?[jt]s$/, "")
    .replace(/\.[cm]?[jt]s$/, "");
}

function filePath(value: string | URL): string {
  if (value instanceof URL) {
    return fileURLToPath(value);
  }

  return value.startsWith("file:") ? fileURLToPath(value) : value;
}
