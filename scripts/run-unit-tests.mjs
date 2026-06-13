import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const testRoots = [
  "packages/workflow/src",
  "packages/engine/src",
];

const testFiles = testRoots.flatMap(discoverUnitTests).sort();

if (testFiles.length === 0) {
  throw new Error("No unit tests found under package src directories");
}

const result = spawnSync("tsx", ["--test", ...testFiles], { stdio: "inherit" });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

/**
 * Discovers package unit tests recursively so new source subdirectories stay covered.
 * Input: a package source root.
 * Output: repository-relative `.unit.test.ts` files in deterministic order.
 * Boundary: this runner owns unit-test discovery only; individual tests still own behavior checks.
 */
function discoverUnitTests(root) {
  const files = [];
  visit(root);
  return files;

  function visit(directory) {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = statSync(path);

      if (stat.isDirectory()) {
        visit(path);
        continue;
      }

      if (stat.isFile() && path.endsWith(".unit.test.ts")) {
        files.push(path);
      }
    }
  }
}
