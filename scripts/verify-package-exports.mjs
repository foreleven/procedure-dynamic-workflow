import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const packageContracts = [
  {
    name: "@pac/workflow",
    runtimeExports: [
      "AckOptionSchema",
      "AckRequestSchema",
      "ConnectorRegistry",
      "DEFAULT_ROUTING_THRESHOLDS",
      "JsonRecordSchema",
      "PrefetchStore",
      "SessionPatchSchema",
      "WorkflowContextStore",
      "createConnectorRegistry",
      "defineConnectorCatalog",
      "defineConnectorRef",
      "defineConnectorTool",
      "definePatch",
      "defineRouting",
      "defineWorkflowDefinition",
      "defineWorkflowHooks",
      "effectAction",
      "hydrateContextAction",
      "loadWorkflowMetadata",
      "prefetchAction",
      "renderAction",
      "resolveAckSelection",
      "setContextAction",
      "setStateAction",
      "settlePrefetch",
      "workflow",
      "workflowActions",
      "z",
    ],
    declaration: {
      path: "packages/workflow/dist/index.d.ts",
      searchPaths: [
        "packages/workflow/dist/ack.d.ts",
        "packages/workflow/dist/actions.d.ts",
        "packages/workflow/dist/builders.d.ts",
        "packages/workflow/dist/common.d.ts",
        "packages/workflow/dist/connectors.d.ts",
        "packages/workflow/dist/hooks.d.ts",
        "packages/workflow/dist/prefetch.d.ts",
        "packages/workflow/dist/program.d.ts",
        "packages/workflow/dist/workflow.d.ts",
        "packages/workflow/dist/workflowMetadata.d.ts",
      ],
      requiredModuleExports: [
        "./ack.js",
        "./actions.js",
        "./builders.js",
        "./common.js",
        "./connectors.js",
        "./hooks.js",
        "./prefetch.js",
        "./program.js",
        "./workflow.js",
        "./workflowMetadata.js",
      ],
      requiredNames: [
        "AckRequest",
        "AckSelection",
        "ConnectorCatalog",
        "ConnectorInput",
        "ConnectorOutput",
        "ConnectorRegistry",
        "PatchPolicy",
        "PrefetchStore",
        "RenderPolicy",
        "RenderResponse",
        "RoutingProfile",
        "SessionContext",
        "WorkflowContext",
        "WorkflowDefinition",
        "WorkflowMetadata",
        "WorkflowNode",
        "WorkflowPatch",
        "WorkflowProgram",
        "WorkflowRuntimeInput",
        "WorkflowStatePatch",
      ],
      forbiddenNames: [
        "sameRuntimeValue",
      ],
    },
  },
  {
    name: "@pac/engine",
    runtimeExports: ["WorkflowEngine", "createLlmClient"],
    declaration: {
      path: "packages/engine/dist/index.d.ts",
      requiredNames: [
        "WorkflowEngine",
        "createLlmClient",
        "LlmClient",
        "LlmClientOptions",
        "LlmStructuredRequest",
        "LlmTextRequest",
        "LlmTextStreamEvent",
        "LlmUsage",
        "CreateSessionInput",
        "EngineDeps",
        "EngineSession",
        "EngineTraceEvent",
        "EngineTurnResult",
        "WorkflowDefinitionInput",
        "WorkflowEngineOptions",
      ],
      forbiddenNames: [
        "RuntimeWorkflow",
        "RuntimeInstance",
        "TargetSelection",
      ],
      forbiddenSnippets: ["export * from"],
    },
  },
];

if (isMainModule()) {
  await verifyPackageExports();
}

/**
 * Verifies package runtime exports and root declaration boundaries against the public API contract.
 * Input: installed workspace packages resolved through npm package names.
 * Output: logs one success line per package or throws on public surface drift.
 * Boundary: this does not verify prose documentation; API doc coverage is checked separately.
 */
export async function verifyPackageExports() {
  for (const contract of packageContracts) {
    const mod = await import(contract.name);
    const actualRuntimeExports = Object.keys(mod).sort();
    const expectedRuntimeExports = contract.runtimeExports.toSorted();
    const missing = expectedRuntimeExports.filter((exportName) => !actualRuntimeExports.includes(exportName));
    const unexpected = actualRuntimeExports.filter((exportName) => !expectedRuntimeExports.includes(exportName));

    if (missing.length > 0) {
      throw new Error(`${contract.name} missing runtime exports: ${missing.join(", ")}`);
    }

    if (unexpected.length > 0) {
      throw new Error(`${contract.name} has unexpected runtime exports: ${unexpected.join(", ")}`);
    }

    if (contract.declaration) {
      verifyDeclarationContract(contract.name, contract.declaration);
    }

    console.log(`ok ${contract.name}: ${expectedRuntimeExports.length} runtime exports`);
  }
}

/**
 * Verifies root declaration boundaries that runtime import checks cannot see.
 * Input: package name plus a dist/index.d.ts contract.
 * Output: throws when the public type surface drifts.
 * Boundary: this checks the package root only; package internals may keep helper types for local modules.
 */
function verifyDeclarationContract(packageName, declaration) {
  const rootSource = readFileSync(resolve(declaration.path), "utf8");
  const source = [declaration.path, ...(declaration.searchPaths ?? [])]
    .map((path) => readFileSync(resolve(path), "utf8"))
    .join("\n");

  for (const modulePath of declaration.requiredModuleExports ?? []) {
    if (!rootSource.includes(`"${modulePath}"`)) {
      throw new Error(`${packageName} root declaration does not export ${modulePath}`);
    }
  }

  for (const name of declaration.requiredNames ?? []) {
    if (!hasWord(source, name)) {
      throw new Error(`${packageName} root declaration is missing ${name}`);
    }
  }

  for (const name of declaration.forbiddenNames ?? []) {
    if (hasWord(source, name)) {
      throw new Error(`${packageName} root declaration exposes internal type ${name}`);
    }
  }

  for (const snippet of declaration.forbiddenSnippets ?? []) {
    if (source.includes(snippet)) {
      throw new Error(`${packageName} root declaration contains forbidden snippet: ${snippet}`);
    }
  }
}

function hasWord(source, word) {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(source);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}
