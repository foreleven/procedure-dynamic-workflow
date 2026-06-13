import { readFileSync } from "node:fs";
import { packageContracts } from "./verify-package-exports.mjs";

const apiDocPath = "docs/API.md";
const apiDoc = readFileSync(apiDocPath, "utf8");
const failures = [];

for (const contract of packageContracts) {
  verifyPackageSection(contract);
  for (const name of documentedNames(contract)) {
    verifyBacktickedName(contract, name);
  }
}

if (failures.length > 0) {
  throw new Error(`API documentation coverage failed:\n${failures.join("\n")}`);
}

console.log(`ok api docs: ${packageContracts.length} packages documented in ${apiDocPath}`);

/**
 * Verifies that every public package has a dedicated API document section.
 * Input: a package public surface contract.
 * Output: records a failure when the package heading is missing.
 * Boundary: section depth is fixed to the maintained API reference layout.
 */
function verifyPackageSection(contract) {
  if (!apiDoc.includes(`## \`${contract.name}\``)) {
    failures.push(`${apiDocPath}: missing package section for ${contract.name}`);
  }
}

/**
 * Collects runtime exports and key public declaration names that should be discoverable in docs.
 * Input: a package public surface contract.
 * Output: sorted unique API names.
 * Boundary: detailed type-member docs can remain manual; this guards top-level public surface drift.
 */
function documentedNames(contract) {
  return [...new Set([
    ...contract.runtimeExports,
    ...(contract.declaration?.requiredNames ?? []),
  ])].sort();
}

function verifyBacktickedName(contract, name) {
  if (!apiDoc.includes(`\`${name}\``)) {
    failures.push(`${apiDocPath}: ${contract.name} public API is not documented: ${name}`);
  }
}
