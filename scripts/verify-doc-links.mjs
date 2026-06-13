import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".tmp",
  "dist",
  "node_modules",
]);

const docs = discoverMarkdownFiles(".");

let failures = 0;

for (const docPath of docs) {
  const content = readFileSync(docPath, "utf8");
  verifyPublicDocContracts(docPath, content);
  const referenced = new Set([
    ...markdownLinks(content),
    ...inlineMarkdownFileReferences(content),
  ]);

  for (const target of referenced) {
    const resolved = resolve(dirname(docPath), target);
    if (!existsSync(resolved)) {
      console.error(`${docPath} references missing file: ${target}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  throw new Error(`Found ${failures} broken documentation link(s)`);
}

console.log(`ok docs: checked ${docs.length} markdown files`);

/**
 * Guards public documentation against stale API claims that link checks cannot catch.
 * Input: repository-relative Markdown path and its source content.
 * Output: increments the shared failure counter when a known-stale phrase appears.
 * Boundary: this is for stable public-facing invariants, not general prose style.
 */
function verifyPublicDocContracts(docPath, content) {
  const forbiddenSnippets = [
    {
      snippet: "`state.messages` is the workflow conversation log",
      reason: "`messages` is runtime-owned and reserved, not workflow-owned state",
    },
  ];

  for (const { snippet, reason } of forbiddenSnippets) {
    if (!content.includes(snippet)) continue;

    console.error(`${docPath} contains stale public API documentation: ${reason}`);
    failures += 1;
  }
}

/**
 * Discovers repository Markdown files that should stay link-checked as documentation grows.
 * Input: repository-relative directory path.
 * Output: sorted repository-relative Markdown paths.
 * Boundary: generated and dependency directories are skipped because they are checked elsewhere or not maintained here.
 */
function discoverMarkdownFiles(root) {
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

      if (stat.isFile() && entry.endsWith(".md")) {
        files.push(path.replace(/^\.\//, ""));
      }
    }
  }
}

function markdownLinks(content) {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/g)]
    .map((match) => stripAnchor(match[1]))
    .filter(isLocalMarkdownPath);
}

function inlineMarkdownFileReferences(content) {
  return [...content.matchAll(/`([^`]+\.md)`/g)]
    .map((match) => match[1])
    .filter(isLocalMarkdownPath);
}

function stripAnchor(path) {
  return path.split("#")[0];
}

function isLocalMarkdownPath(path) {
  return (
    path.endsWith(".md") &&
    !path.startsWith("http://") &&
    !path.startsWith("https://") &&
    !path.startsWith("mailto:")
  );
}
