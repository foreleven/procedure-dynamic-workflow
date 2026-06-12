import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { defineRouting } from "./builders.js";
import type { RoutingProfile, WorkflowId } from "./common.js";

const RoutingThresholdsSchema = z.object({
  localAccept: z.number().optional(),
  localUncertain: z.number().optional(),
  globalAccept: z.number().optional(),
});

const WorkflowMetadataFileSchema = z.object({
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

export interface WorkflowMetadata {
  id: WorkflowId;
  version: string;
  description: string;
  routing: RoutingProfile;
}

export function loadWorkflowMetadata(relativeTo: string | URL, metadataPath = "./workflow.yaml"): WorkflowMetadata {
  const absolutePath = resolve(dirname(filePath(relativeTo)), metadataPath);
  const parsed = WorkflowMetadataFileSchema.parse(YAML.parse(readFileSync(absolutePath, "utf8")));

  return {
    id: parsed.id,
    version: parsed.version,
    description: parsed.description,
    routing: defineRouting(parsed.routing),
  };
}

function filePath(value: string | URL): string {
  if (value instanceof URL) {
    return fileURLToPath(value);
  }

  return value.startsWith("file:") ? fileURLToPath(value) : value;
}
