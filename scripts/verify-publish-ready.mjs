import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageContracts = [
  {
    name: "@pac/workflow",
    path: resolveRepositoryPath("packages/workflow/package.json"),
  },
  {
    name: "@pac/engine",
    path: resolveRepositoryPath("packages/engine/package.json"),
  },
];

const targets = new Set(process.argv.slice(2));
const selectedContracts =
  targets.size === 0 ? packageContracts : packageContracts.filter((contract) => targets.has(contract.name));

try {
  verifyPublishReadiness(selectedContracts, targets);
} catch (error) {
  console.error(`publish readiness failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

/**
 * Verifies release-only requirements that should block npm publish but not default CI.
 * Input: selected package contracts and requested package names.
 * Output: logs success or throws with the first actionable release blocker.
 * Boundary: this does not choose or validate the appropriateness of a license.
 */
function verifyPublishReadiness(selected, requestedTargets) {
  const selectedNames = new Set(selected.map((contract) => contract.name));
  const unknownTargets = [...requestedTargets].filter((target) => !selectedNames.has(target));
  if (unknownTargets.length > 0) {
    throw new Error(`Unknown publish target(s): ${unknownTargets.join(", ")}`);
  }

  verifyRepositoryLicense();

  for (const contract of selected) {
    const pkg = readJson(contract.path);
    if (pkg.name !== contract.name) {
      throw new Error(`${contract.path} name mismatch: ${pkg.name} !== ${contract.name}`);
    }
    if (typeof pkg.license !== "string" || pkg.license.trim().length === 0) {
      throw new Error(`${contract.name} must declare the selected license before publishing`);
    }
  }

  console.log(`ok publish readiness: ${selected.map((contract) => contract.name).join(", ")}`);
}

/**
 * Ensures maintainers make the legal release decision before any npm publish attempt succeeds.
 * Input: repository root LICENSE file.
 * Output: throws when the release license is missing or empty.
 * Boundary: this validates presence, not whether a particular license is appropriate for the project.
 */
function verifyRepositoryLicense() {
  const licensePath = resolveRepositoryPath("LICENSE");
  if (!existsSync(licensePath)) {
    throw new Error("Repository LICENSE is required before publishing packages");
  }

  if (readFileSync(licensePath, "utf8").trim().length === 0) {
    throw new Error("Repository LICENSE must not be empty before publishing packages");
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveRepositoryPath(path) {
  return resolve(repositoryRoot, path);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
