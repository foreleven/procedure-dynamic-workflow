import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".tmp",
  "dist",
  "node_modules",
]);

const forbiddenTrackedPatterns = [
  /^packages\/[^/]+\/dist\//,
  /^\.tmp\//,
  /^node_modules\//,
  /^coverage\//,
  /(^|\/)\.DS_Store$/,
  /^\.env(?:$|\.(?!example$))/,
  /\.log$/,
  /\.tsbuildinfo$/,
];

const scannedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
]);

const forbiddenSourceSnippets = [
  { snippet: "@ts-ignore", reason: "use a narrow @ts-expect-error with a type smoke assertion instead" },
  { snippet: "@ts-nocheck", reason: "keep source files type-checked" },
  { snippet: "eslint-disable", reason: "do not hide source checks without a dedicated project lint policy" },
  { snippet: "as any", reason: "avoid unsound public or runtime type escapes" },
  { snippet: "unknown as", reason: "prefer overloads or explicit validators instead of double casts" },
  { snippet: "debugger", reason: "debugger statements must not land in repository source" },
  { snippet: "TODO", reason: "track follow-up work in docs or issues instead of leaving ambiguous source notes" },
  { snippet: "FIXME", reason: "fix the issue or document it as an explicit release blocker" },
];

const trackedFiles = gitLsFiles();
const forbiddenTrackedFiles = trackedFiles.filter((path) =>
  forbiddenTrackedPatterns.some((pattern) => pattern.test(path)),
);

if (forbiddenTrackedFiles.length > 0) {
  throw new Error(`Tracked local/generated files are not allowed:\n${forbiddenTrackedFiles.join("\n")}`);
}

const sourceFiles = discoverSourceFiles(".");
const sourceFailures = [];

for (const path of sourceFiles) {
  if (path === "scripts/verify-source-hygiene.mjs") continue;

  const source = readFileSync(path, "utf8");
  for (const { snippet, reason } of forbiddenSourceSnippets) {
    if (!source.includes(snippet)) continue;
    sourceFailures.push(`${path}: contains ${snippet} (${reason})`);
  }
}

if (sourceFailures.length > 0) {
  throw new Error(`Source hygiene check failed:\n${sourceFailures.join("\n")}`);
}

console.log(`ok source hygiene: ${trackedFiles.length} tracked files, ${sourceFiles.length} source files`);

/**
 * Lists tracked repository files using git so generated/local artifacts cannot be committed unnoticed.
 * Input: none.
 * Output: repository-relative paths tracked by git.
 * Boundary: untracked files are handled by .gitignore and specific source scans.
 */
function gitLsFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

/**
 * Discovers source-like files in the working tree, including untracked files being prepared for commit.
 * Input: repository-relative root directory.
 * Output: sorted paths for TypeScript and JavaScript source files.
 * Boundary: dependency, build, and temporary directories are skipped.
 */
function discoverSourceFiles(root) {
  const files = [];
  visit(root);
  return files.sort();

  function visit(directory) {
    for (const entry of readdirSync(directory)) {
      if (ignoredDirectories.has(entry)) continue;

      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }

      if (stat.isFile() && scannedExtensions.has(extension(entry))) {
        files.push(path.replace(/^\.\//, ""));
      }
    }
  }
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}
