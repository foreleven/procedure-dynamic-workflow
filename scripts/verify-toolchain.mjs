import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const expectedPackageManager = parsePackageManager(pkg.packageManager);
const expectedNodeRange = parseMinimumNodeVersion(pkg.engines?.node);
const actualNodeVersion = process.versions.node;
const actualNpmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();

if (expectedPackageManager.name !== "npm") {
  throw new Error(`Unsupported package manager: ${pkg.packageManager}`);
}

if (!isAtLeastVersion(actualNodeVersion, expectedNodeRange)) {
  throw new Error(`Node.js ${actualNodeVersion} does not satisfy ${pkg.engines.node}`);
}

if (actualNpmVersion !== expectedPackageManager.version) {
  throw new Error(`npm ${actualNpmVersion} does not match ${pkg.packageManager}`);
}

console.log(`ok toolchain: node ${actualNodeVersion}, npm ${actualNpmVersion}`);

/**
 * Parses the packageManager field used by npm and CI.
 * Input: packageManager string from package.json.
 * Output: package manager name and exact version.
 * Boundary: this project currently supports a single exact npm version, not ranges.
 */
function parsePackageManager(value) {
  if (typeof value !== "string") {
    throw new Error("packageManager must be a string");
  }

  const match = /^([^@]+)@(.+)$/.exec(value);
  if (!match) {
    throw new Error(`packageManager must use <name>@<version>: ${value}`);
  }

  const [, name, version] = match;
  return { name, version };
}

/**
 * Parses the Node.js engine lower bound declared for contributors and CI.
 * Input: engines.node from package.json.
 * Output: semantic version tuple used for runtime comparison.
 * Boundary: this intentionally supports the project's current >=x.y.z contract.
 */
function parseMinimumNodeVersion(value) {
  if (typeof value !== "string") {
    throw new Error("engines.node must be a string");
  }

  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`engines.node must use >=x.y.z: ${value}`);
  }

  return toVersionTuple(match.slice(1).join("."));
}

function isAtLeastVersion(actual, minimum) {
  const actualParts = toVersionTuple(actual);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actualParts[index] > minimum[index]) return true;
    if (actualParts[index] < minimum[index]) return false;
  }

  return true;
}

function toVersionTuple(version) {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  return parts;
}
