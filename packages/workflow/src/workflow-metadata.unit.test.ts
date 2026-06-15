import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { loadWorkflowMetadata } from "./workflow-metadata.js";

test("loadWorkflowMetadata rejects invalid routing thresholds", () => {
  const tempDir = mkdtempSync(resolve(tmpdir(), "pac-workflow-metadata-"));
  try {
    writeFileSync(
      resolve(tempDir, "agent.yaml"),
      `
workflows:
  invalid_thresholds:
    id: invalid_thresholds
    version: 0.1.0
    description: Invalid routing thresholds fixture.
    routing:
      examples:
        - book maintenance
      entities:
        - vehicle
      neighbors: []
      thresholds:
        localAccept: -0.1
`,
    );

    assert.throws(
      () => loadWorkflowMetadata(resolve(tempDir, "workflows", "invalid_thresholds.workflow.ts"), "../agent.yaml"),
      /Too small|greater than or equal to 0/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
