import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArgs,
  usageText,
} from "./cli/support.js";

test("CLI usage documents the required workflow flag and environment variables", () => {
  const usage = usageText();

  assert.match(usage, /Usage:/);
  assert.match(usage, /--workflow <workflow-file>/);
  assert.match(usage, /OPENAI_API_KEY/);
});

test("parseArgs requires a workflow path before runtime startup", () => {
  assert.throws(() => parseArgs([]), /Missing required --workflow <path>/);
});

test("parseArgs rejects missing values for file and configuration flags", () => {
  assert.throws(() => parseArgs(["--workflow", "--debug"]), /Missing value for --workflow/);
  assert.throws(() => parseArgs(["--workflow", "flow.ts", "--connectors"]), /Missing value for --connectors/);
  assert.throws(() => parseArgs(["--workflow", "flow.ts", "--model"]), /Missing value for --model/);
});

test("parseArgs accepts flag-like message payloads without consuming configuration flags", () => {
  const options = parseArgs(["--workflow", "flow.ts", "--message", "--not-a-flag"]);

  assert.equal(options.workflowPath, "flow.ts");
  assert.deepEqual(options.messages, ["--not-a-flag"]);
});

