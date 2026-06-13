import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

await verifyHelp();
await verifyMissingWorkflow();
await verifyMissingOptionValue();

console.log("ok cli smoke: help and argument validation");

/**
 * Verifies that the public development CLI can start without model credentials.
 * Input: none; runs the CLI with --help.
 * Output: throws when help exits non-zero or omits expected usage text.
 * Boundary: this intentionally avoids workflow execution and real LLM calls.
 */
async function verifyHelp() {
  const { stdout } = await execFileAsync("tsx", ["packages/engine/src/cli.ts", "--help"], {
    maxBuffer: 1024 * 1024,
  });

  assertIncludes(stdout, "Usage:", "CLI help output");
  assertIncludes(stdout, "--workflow <workflow-file>", "CLI help output");
  assertIncludes(stdout, "OPENAI_API_KEY", "CLI help output");
}

/**
 * Verifies the first actionable CLI error for a missing workflow file.
 * Input: none; runs the CLI without arguments.
 * Output: throws when the process unexpectedly succeeds or reports a different error.
 * Boundary: this checks argument validation only, not dynamic module loading.
 */
async function verifyMissingWorkflow() {
  try {
    await execFileAsync("tsx", ["packages/engine/src/cli.ts"], {
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const stderr = error?.stderr ?? "";
    assertIncludes(stderr, "Missing required --workflow <path>", "CLI missing workflow error");
    return;
  }

  throw new Error("CLI without --workflow unexpectedly succeeded");
}

/**
 * Verifies that option flags cannot accidentally consume another flag as their value.
 * Input: none; runs the CLI with --workflow followed by another option.
 * Output: throws when the CLI reports a late file-loading error instead of argument validation.
 * Boundary: this protects configuration flags; message payload parsing is intentionally separate.
 */
async function verifyMissingOptionValue() {
  try {
    await execFileAsync("tsx", ["packages/engine/src/cli.ts", "--workflow", "--debug"], {
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const stderr = error?.stderr ?? "";
    assertIncludes(stderr, "Missing value for --workflow", "CLI missing option value error");
    return;
  }

  throw new Error("CLI with missing --workflow value unexpectedly succeeded");
}

function assertIncludes(value, expected, label) {
  if (typeof value !== "string" || !value.includes(expected)) {
    throw new Error(`${label} must include ${expected}`);
  }
}
