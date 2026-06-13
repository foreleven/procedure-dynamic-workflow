import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryLicensePath = resolve(repositoryRoot, "LICENSE");
const repositoryLicenseExists = existsSync(repositoryLicensePath);

const packageContracts = [
  {
    name: "@pac/workflow",
    cwd: resolve(repositoryRoot, "packages/workflow"),
  },
  {
    name: "@pac/engine",
    cwd: resolve(repositoryRoot, "packages/engine"),
  },
];

for (const contract of packageContracts) {
  verifyPublishGuardFromPackageCwd(contract);
}

console.log(`ok publish lifecycle: ${packageContracts.length} workspace prepublish guards resolve repository root`);

/**
 * Verifies the package prepublish guard behaves correctly when launched from a workspace package directory.
 * Input: package name and package working directory.
 * Output: throws when path resolution depends on the package cwd.
 * Boundary: this checks lifecycle path safety, not the maintainer's license choice.
 */
function verifyPublishGuardFromPackageCwd(contract) {
  const packageLicensePath = resolve(contract.cwd, "LICENSE");
  const createdPackageLicense = ensurePackageLocalLicense(packageLicensePath);

  try {
    const result = runPublishGuard(contract);
    assertLifecycleResult(contract, result);
  } finally {
    if (createdPackageLicense) {
      rmSync(packageLicensePath, { force: true });
    }
  }
}

/**
 * Ensures a package-local LICENSE exists so cwd-relative implementations are distinguishable.
 * Input: package-local license path.
 * Output: true when this script created a temporary sentinel file.
 * Boundary: existing package license files are never modified or removed.
 */
function ensurePackageLocalLicense(path) {
  if (existsSync(path)) {
    return false;
  }

  writeFileSync(path, "temporary publish lifecycle sentinel\n");
  return true;
}

/**
 * Runs the publish guard from a package directory using the same relative script path as package metadata.
 * Input: package contract with workspace cwd and package name.
 * Output: command status plus stdout and stderr.
 * Boundary: npm lifecycle environment variables are not required for this path-resolution check.
 */
function runPublishGuard(contract) {
  const result = spawnSync("node", ["../../scripts/verify-publish-ready.mjs", contract.name], {
    cwd: contract.cwd,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertLifecycleResult(contract, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes("ENOENT") || output.includes("Cannot find module")) {
    throw new Error(`${contract.name} publish guard appears to resolve paths from package cwd:\n${output}`);
  }

  if (!repositoryLicenseExists && !output.includes("Repository LICENSE is required before publishing packages")) {
    throw new Error(`${contract.name} publish guard did not report the repository LICENSE blocker:\n${output}`);
  }
}
