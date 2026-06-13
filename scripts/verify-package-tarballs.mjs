import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageContracts = [
  {
    workspace: "@pac/workflow",
    readmePath: "packages/workflow/README.md",
    expectedFiles: [
      "package.json",
      "README.md",
      "dist/index.js",
      "dist/index.d.ts",
    ],
  },
  {
    workspace: "@pac/engine",
    readmePath: "packages/engine/README.md",
    expectedFiles: [
      "package.json",
      "README.md",
      "dist/index.js",
      "dist/index.d.ts",
    ],
  },
];

for (const contract of packageContracts) {
  const pack = await packDryRun(contract.workspace);
  const files = new Set(pack.files.map((file) => file.path));
  const missing = contract.expectedFiles.filter((file) => !files.has(file));
  const forbidden = pack.files.map((file) => file.path).filter(isForbiddenPublishedFile);

  if (missing.length > 0) {
    throw new Error(`${contract.workspace} package is missing files: ${missing.join(", ")}`);
  }

  if (forbidden.length > 0) {
    throw new Error(`${contract.workspace} package includes forbidden files: ${forbidden.join(", ")}`);
  }

  if (!pack.files.some((file) => file.path.startsWith("dist/") && file.path.endsWith(".js"))) {
    throw new Error(`${contract.workspace} package does not include compiled JavaScript`);
  }

  verifyPublishedReadme(contract);

  console.log(`ok ${contract.workspace}: ${pack.files.length} package files`);
}

async function packDryRun(workspace) {
  const { stdout } = await execFileAsync("npm", ["pack", "--workspace", workspace, "--dry-run", "--json"], {
    maxBuffer: 1024 * 1024 * 10,
  });
  const parsed = parseNpmPackJson(stdout);
  const [pack] = parsed;

  if (!pack || !Array.isArray(pack.files)) {
    throw new Error(`Unexpected npm pack output for ${workspace}`);
  }

  return pack;
}

/**
 * Parses npm pack --json output even when lifecycle scripts print logs before the JSON payload.
 * Input: raw stdout from npm pack.
 * Output: parsed JSON array emitted by npm.
 * Boundary: npm emits the pack result as the final JSON array; earlier stdout is diagnostic text.
 */
function parseNpmPackJson(stdout) {
  const start = stdout.lastIndexOf("\n[");
  const jsonStart = start >= 0 ? start + 1 : stdout.indexOf("[");
  if (jsonStart < 0) {
    throw new Error(`npm pack did not emit JSON:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

/**
 * Blocks files that are useful in the repository but should not be published to npm packages.
 * Input: package-relative tarball path from npm pack --json.
 * Output: true when the file should fail the tarball smoke check.
 * Boundary: source maps are blocked because packages do not publish the referenced src files.
 */
function isForbiddenPublishedFile(path) {
  return (
    path.startsWith("src/") ||
    path.startsWith("dist/cli.") ||
    path.includes(".unit.test.") ||
    path.includes(".manual.") ||
    path.endsWith(".map") ||
    path.endsWith(".tsbuildinfo") ||
    (path.endsWith(".ts") && !path.endsWith(".d.ts"))
  );
}

/**
 * Keeps published package README files focused on package consumers rather than repository scripts.
 * Input: package contract with the workspace README path.
 * Output: throws when README content would advertise repo-only npm commands in the npm package page.
 * Boundary: root repository docs may still document contributor commands.
 */
function verifyPublishedReadme(contract) {
  const readme = readFileSync(contract.readmePath, "utf8");
  const repoOnlyCommand = readme
    .split(/\r?\n/)
    .find((line) => /^\s*npm run\b/.test(line));

  if (repoOnlyCommand) {
    throw new Error(`${contract.workspace} README includes repo-only command: ${repoOnlyCommand.trim()}`);
  }
}
