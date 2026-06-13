import { existsSync, readFileSync } from "node:fs";

const repositoryUrl = "git+https://github.com/foreleven/procedure-dynamic-workflow.git";
const issueUrl = "https://github.com/foreleven/procedure-dynamic-workflow/issues";
const licenseExists = existsSync("LICENSE");

const rootPackage = readJson("package.json");
const packageContracts = [
  {
    path: "packages/workflow/package.json",
    name: "@pac/workflow",
    directory: "packages/workflow",
    homepage: "https://github.com/foreleven/procedure-dynamic-workflow/tree/main/packages/workflow#readme",
    requiredKeywords: ["workflow", "dsl", "llm"],
    prepublishOnly: "node ../../scripts/verify-publish-ready.mjs @pac/workflow",
    dependencies: {
      yaml: "^2.9.0",
      zod: "^4.4.3",
    },
  },
  {
    path: "packages/engine/package.json",
    name: "@pac/engine",
    directory: "packages/engine",
    homepage: "https://github.com/foreleven/procedure-dynamic-workflow/tree/main/packages/engine#readme",
    requiredKeywords: ["workflow", "runtime", "llm"],
    prepublishOnly: "node ../../scripts/verify-publish-ready.mjs @pac/engine",
    dependencies: {
      "@earendil-works/pi-ai": "^0.79.1",
      "@pac/workflow": "0.1.0",
      zod: "^4.4.3",
    },
    internalDependencies: {
      "@pac/workflow": "@pac/workflow",
    },
  },
];

verifyRootPackage(rootPackage);
verifyLockfileRegistries(readJson("package-lock.json"));
verifyGithubActionsWorkflow(readFileSync(".github/workflows/ci.yml", "utf8"));
verifyRepositoryHygiene(readFileSync(".gitignore", "utf8"));
verifyEnvironmentExample(readFileSync(".env.example", "utf8"));
verifyToolingConfig(readFileSync(".editorconfig", "utf8"), readFileSync(".npmrc", "utf8"));
verifyCommunityHealthFiles({
  readme: readFileSync("README.md", "utf8"),
  contributing: readFileSync("CONTRIBUTING.md", "utf8"),
  support: readFileSync("SUPPORT.md", "utf8"),
  codeOfConduct: readFileSync("CODE_OF_CONDUCT.md", "utf8"),
  issueTemplateConfig: readFileSync(".github/ISSUE_TEMPLATE/config.yml", "utf8"),
});

const workspacePackages = new Map(
  packageContracts.map((contract) => {
    const pkg = readJson(contract.path);
    verifyWorkspacePackage(contract, pkg);
    return [contract.name, pkg];
  }),
);

verifyInternalDependencyVersions(packageContracts, workspacePackages);

console.log(`ok package metadata: ${packageContracts.length} workspace packages`);

/**
 * Verifies the root workspace metadata that contributors rely on before running scripts.
 * Input: parsed root package.json.
 * Output: throws on missing repository, engine, package manager, or workspace contract fields.
 * Boundary: this does not validate publishable package tarball contents; tarball checks live separately.
 */
function verifyRootPackage(pkg) {
  assertEqual(pkg.private, true, "root private");
  assertEqual(pkg.type, "module", "root type");
  assertEqual(pkg.packageManager, "npm@11.12.1", "root packageManager");
  assertEqual(pkg.engines?.node, ">=24.0.0", "root engines.node");
  assertNoDependencies(pkg.dependencies, "root dependencies");
  assertArrayIncludes(pkg.workspaces, "packages/*", "root workspaces");
  assertEqual(pkg.scripts?.["toolchain:check"], "node scripts/verify-toolchain.mjs", "root toolchain:check script");
  assertEqual(pkg.scripts?.clean, "npm run clean -w @pac/workflow && npm run clean -w @pac/engine", "root clean script");
  assertEqual(pkg.scripts?.["source:check"], "node scripts/verify-source-hygiene.mjs", "root source:check script");
  assertEqual(pkg.scripts?.["cli:check"], "node scripts/verify-cli-smoke.mjs", "root cli:check script");
  assertStartsWith(pkg.scripts?.ci, "npm run toolchain:check && ", "root ci script");
  assertIncludes(pkg.scripts?.ci, "npm run source:check", "root ci script");
  assertIncludes(pkg.scripts?.ci, "npm run cli:check", "root ci script");
  assertIncludes(pkg.scripts?.ci, "npm run docs:check", "root ci script");
  assertIncludes(pkg.scripts?.["docs:check"], "node scripts/verify-doc-links.mjs", "root docs:check script");
  assertIncludes(pkg.scripts?.["docs:check"], "node scripts/verify-api-docs.mjs", "root docs:check script");
  assertEqual(
    pkg.scripts?.["publish:lifecycle:check"],
    "node scripts/verify-publish-lifecycle.mjs",
    "root publish:lifecycle:check script",
  );
  assertIncludes(pkg.scripts?.ci, "npm run publish:lifecycle:check", "root ci script");
  assertEqual(pkg.scripts?.["publish:check"], "node scripts/verify-publish-ready.mjs", "root publish:check script");
  assertEqual(pkg.devDependencies?.dotenv, "^17.4.2", "root devDependencies.dotenv");
  verifyRepository(pkg, undefined, "root");
  assertEqual(pkg.bugs?.url, issueUrl, "root bugs.url");
  assertEqual(pkg.homepage, "https://github.com/foreleven/procedure-dynamic-workflow#readme", "root homepage");
  verifyLicenseState(pkg, "root package");
}

/**
 * Verifies that hosted CI uses the same toolchain contract as local contributors.
 * Input: GitHub Actions workflow text.
 * Output: throws when npm is not pinned and verified before dependency installation.
 * Boundary: this checks the project-owned CI contract, not arbitrary downstream workflows.
 */
function verifyGithubActionsWorkflow(workflow) {
  assertIncludes(workflow, "permissions:\n  contents: read", "CI workflow token permissions");
  assertIncludes(workflow, "uses: actions/setup-node@v4", "CI workflow setup-node action");
  assertIncludes(workflow, "persist-credentials: false", "CI workflow checkout credentials");
  assertIncludes(workflow, "node-version: 24", "CI workflow node version");
  assertIncludes(workflow, `npm install -g ${rootPackage.packageManager}`, "CI workflow npm pin");
  assertOrder(
    workflow,
    [`npm install -g ${rootPackage.packageManager}`, "npm run toolchain:check", "npm ci", "npm run ci"],
    "CI workflow toolchain order",
  );
}

/**
 * Verifies ignore rules for generated files and local-only secrets.
 * Input: .gitignore source.
 * Output: throws when common build, test, package, or environment artifacts are not ignored.
 * Boundary: this protects repository hygiene only; npm tarball contents are checked separately.
 */
function verifyRepositoryHygiene(gitignore) {
  for (const pattern of [
    "node_modules",
    "packages/*/dist",
    ".tmp",
    "coverage",
    "*.log",
    "*.tsbuildinfo",
    ".env",
    ".env.*",
    "!.env.example",
  ]) {
    assertIncludesLine(gitignore, pattern, ".gitignore");
  }
}

/**
 * Verifies the checked-in environment template documents local model-provider settings.
 * Input: .env.example source.
 * Output: throws when required keys are missing or accidentally populated.
 * Boundary: this template is intentionally limited to local CLI and manual LLM smoke settings.
 */
function verifyEnvironmentExample(source) {
  const entries = new Map(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex < 0) {
          throw new Error(`.env.example line must use KEY= format: ${line}`);
        }

        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );

  for (const key of ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"]) {
    if (!entries.has(key)) {
      throw new Error(`.env.example must include ${key}`);
    }

    assertEqual(entries.get(key), "", `.env.example ${key}`);
  }
}

/**
 * Verifies repository-level tool configuration that should be stable for contributors.
 * Input: .editorconfig and .npmrc sources.
 * Output: throws when editor basics or npm engine enforcement are missing.
 * Boundary: this does not replace TypeScript or package smoke checks.
 */
function verifyToolingConfig(editorconfig, npmrc) {
  for (const line of [
    "root = true",
    "charset = utf-8",
    "end_of_line = lf",
    "insert_final_newline = true",
    "indent_style = space",
    "indent_size = 2",
    "trim_trailing_whitespace = true",
    "[*.md]",
    "trim_trailing_whitespace = false",
  ]) {
    assertIncludesLine(editorconfig, line, ".editorconfig");
  }

  assertIncludesLine(npmrc, "engine-strict=true", ".npmrc");
}

/**
 * Verifies project community health files and their discoverability from public docs.
 * Input: top-level docs plus issue template config.
 * Output: throws when conduct/support docs are missing key sections or are not linked.
 * Boundary: this checks existence and routing, not legal or governance decisions.
 */
function verifyCommunityHealthFiles(files) {
  assertIncludes(files.readme, "SUPPORT.md", "README support link");
  assertIncludes(files.readme, "CODE_OF_CONDUCT.md", "README code of conduct link");
  assertIncludes(files.contributing, "SUPPORT.md", "CONTRIBUTING support link");
  assertIncludes(files.contributing, "CODE_OF_CONDUCT.md", "CONTRIBUTING code of conduct link");

  assertIncludes(files.support, "# Support", "SUPPORT.md title");
  assertIncludes(files.support, "SECURITY.md", "SUPPORT.md security link");
  assertIncludes(files.support, "npm run test:llm", "SUPPORT.md manual LLM note");

  assertIncludes(files.codeOfConduct, "# Code of Conduct", "CODE_OF_CONDUCT.md title");
  assertIncludes(files.codeOfConduct, "Expected Behavior", "CODE_OF_CONDUCT.md expected behavior");
  assertIncludes(files.codeOfConduct, "Unacceptable Behavior", "CODE_OF_CONDUCT.md unacceptable behavior");
  assertIncludes(files.codeOfConduct, "SECURITY.md", "CODE_OF_CONDUCT.md security link");

  assertIncludes(files.issueTemplateConfig, "SUPPORT.md", "issue template support link");
  assertIncludes(files.issueTemplateConfig, "security/advisories/new", "issue template security link");
}

/**
 * Verifies npm-visible package metadata for publishable workspaces.
 * Input: expected contract and parsed package.json.
 * Output: throws on missing metadata or mismatched public entry points.
 * Boundary: this intentionally leaves license selection to maintainers until LICENSE exists.
 */
function verifyWorkspacePackage(contract, pkg) {
  assertEqual(pkg.name, contract.name, `${contract.name} name`);
  assertString(pkg.version, `${contract.name} version`);
  assertString(pkg.description, `${contract.name} description`);
  assertEqual(pkg.type, "module", `${contract.name} type`);
  assertEqual(pkg.engines?.node, rootPackage.engines?.node, `${contract.name} engines.node`);
  verifyRepository(pkg, contract.directory, contract.name);
  assertEqual(pkg.bugs?.url, issueUrl, `${contract.name} bugs.url`);
  assertEqual(pkg.homepage, contract.homepage, `${contract.name} homepage`);
  assertEqual(pkg.main, "./dist/index.js", `${contract.name} main`);
  assertEqual(pkg.types, "./dist/index.d.ts", `${contract.name} types`);
  assertEqual(pkg.exports?.["."]?.import, "./dist/index.js", `${contract.name} exports import`);
  assertEqual(pkg.exports?.["."]?.types, "./dist/index.d.ts", `${contract.name} exports types`);
  assertEqual(pkg.publishConfig?.access, "public", `${contract.name} publishConfig.access`);
  assertArrayIncludes(pkg.files, "dist", `${contract.name} files`);
  assertArrayIncludes(pkg.files, "README.md", `${contract.name} files`);
  assertEqual(
    pkg.scripts?.clean,
    "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
    `${contract.name} clean script`,
  );
  assertEqual(pkg.scripts?.build, "npm run clean && tsc -p tsconfig.build.json", `${contract.name} build script`);
  assertString(pkg.scripts?.prepack, `${contract.name} prepack script`);
  assertEqual(pkg.scripts?.prepublishOnly, contract.prepublishOnly, `${contract.name} prepublishOnly script`);

  for (const keyword of contract.requiredKeywords) {
    assertArrayIncludes(pkg.keywords, keyword, `${contract.name} keywords`);
  }

  verifyDependencySet(pkg.dependencies, contract.dependencies, `${contract.name} dependencies`);
  verifyLicenseState(pkg, contract.name);
}

/**
 * Keeps workspace dependency ranges aligned with the local package versions.
 * Input: workspace package contracts and parsed package map.
 * Output: throws when an internal dependency drifts from the matching package version.
 * Boundary: external dependency version policy stays in package.json review.
 */
function verifyInternalDependencyVersions(contracts, packagesByName) {
  for (const contract of contracts) {
    const pkg = packagesByName.get(contract.name);
    if (!pkg || !contract.internalDependencies) continue;

    for (const [dependencyName, packageName] of Object.entries(contract.internalDependencies)) {
      const dependencyVersion = pkg.dependencies?.[dependencyName];
      const targetVersion = packagesByName.get(packageName)?.version;
      if (dependencyVersion !== targetVersion) {
        throw new Error(
          `${contract.name} dependency ${dependencyName} must match ${packageName} version: ${dependencyVersion} !== ${targetVersion}`,
        );
      }
    }
  }
}

/**
 * Keeps published runtime dependency declarations exact enough to avoid leaking dev-only packages.
 * Input: actual package dependencies and expected package contract dependencies.
 * Output: throws when a runtime dependency is missing, unexpected, or version-mismatched.
 * Boundary: root development dependencies are checked separately in `verifyRootPackage`.
 */
function verifyDependencySet(actual, expected, label) {
  const actualDependencies = actual ?? {};
  const actualNames = Object.keys(actualDependencies).sort();
  const expectedNames = Object.keys(expected ?? {}).sort();

  assertArrayEqual(actualNames, expectedNames, `${label} names`);
  for (const [name, version] of Object.entries(expected ?? {})) {
    assertEqual(actualDependencies[name], version, `${label}.${name}`);
  }
}

function assertNoDependencies(value, label) {
  if (value === undefined) return;
  const names = Object.keys(value);
  if (names.length > 0) {
    throw new Error(`${label} must be empty for the private workspace root: ${names.join(", ")}`);
  }
}

/**
 * Prevents private registry URLs from leaking into the public lockfile.
 * Input: parsed package-lock.json.
 * Output: throws when a package tarball is pinned to a non-public npm registry.
 * Boundary: workspace links do not have resolved tarball URLs and are ignored.
 */
function verifyLockfileRegistries(lockfile) {
  const packages = lockfile.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("package-lock.json must contain a packages object");
  }

  for (const [path, entry] of Object.entries(packages)) {
    const resolved = entry?.resolved;
    if (typeof resolved !== "string" || !resolved.startsWith("http")) continue;

    const url = new URL(resolved);
    if (url.hostname !== "registry.npmjs.org") {
      throw new Error(`${path || "root"} resolves from non-public registry: ${resolved}`);
    }
  }
}

function verifyRepository(pkg, directory, label) {
  assertEqual(pkg.repository?.type, "git", `${label} repository.type`);
  assertEqual(pkg.repository?.url, repositoryUrl, `${label} repository.url`);
  if (directory) {
    assertEqual(pkg.repository?.directory, directory, `${label} repository.directory`);
  }
}

function verifyLicenseState(pkg, label) {
  if (licenseExists) {
    assertString(pkg.license, `${label} license`);
    return;
  }

  if ("license" in pkg) {
    throw new Error(`${label} declares a license before repository LICENSE exists`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertArrayIncludes(value, expected, label) {
  if (!Array.isArray(value) || !value.includes(expected)) {
    throw new Error(`${label} must include ${expected}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((item, index) => item !== expected[index])
  ) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

function assertIncludes(value, expected, label) {
  if (typeof value !== "string" || !value.includes(expected)) {
    throw new Error(`${label} must include ${expected}`);
  }
}

function assertIncludesLine(value, expected, label) {
  const lines = value.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(expected)) {
    throw new Error(`${label} must include line ${expected}`);
  }
}

function assertStartsWith(value, expectedPrefix, label) {
  if (typeof value !== "string" || !value.startsWith(expectedPrefix)) {
    throw new Error(`${label} must start with ${expectedPrefix}`);
  }
}

function assertOrder(value, expectedParts, label) {
  let previousIndex = -1;
  for (const part of expectedParts) {
    const index = value.indexOf(part, previousIndex + 1);
    if (index === -1) {
      throw new Error(`${label} must include ${part} after index ${previousIndex}`);
    }

    previousIndex = index;
  }
}
