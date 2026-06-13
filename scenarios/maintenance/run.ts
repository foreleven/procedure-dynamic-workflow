import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "@pac/workflow";
import { createLlmClient, WorkflowEngine } from "@pac/engine";
import maintenanceBookingWorkflow, {
  type MaintenanceState,
} from "./maintenance_booking.workflow.js";
import connectors from "./connectors.js";

const TurnExpectationSchema = z.object({
  responseSatisfies: z.string(),
});

const WorkflowCaseSchema = z.object({
  id: z.string(),
  description: z.string(),
  userId: z.string().default("user_feng"),
  turns: z.array(
    z.object({
      message: z.string(),
      expect: TurnExpectationSchema,
    }),
  ),
});

const WorkflowCasesFileSchema = z.object({
  cases: z.array(WorkflowCaseSchema),
});

const ResponseJudgementSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reason: z.string(),
});

type WorkflowCase = z.infer<typeof WorkflowCaseSchema>;

const llm = createLlmClient();

const engine = new WorkflowEngine({
  workflows: [maintenanceBookingWorkflow],
  deps: {
    llm,
    connectors,
    now: () => new Date("2026-06-11T10:00:00+08:00"),
  },
});

const cases = loadCases();
for (const testCase of cases) {
  await runCase(testCase);
}

console.log(`Verified ${cases.length} maintenance workflow cases.`);

async function runCase(testCase: WorkflowCase): Promise<void> {
  const session = engine.createSession({
    sessionId: `case_${testCase.id}`,
    userId: testCase.userId,
    activeWorkflowIds: [maintenanceBookingWorkflow.id],
  });

  console.log(`CASE ${testCase.id}: ${testCase.description}`);

  for (const [index, turn] of testCase.turns.entries()) {
    const result = await engine.onMessage(turn.message, session);
    const instance = engine.getInstance<MaintenanceState>(session, "maintenance_booking");
    const state = instance?.state;
    const prefix = `${testCase.id} turn ${index + 1}`;

    console.log(`${prefix}: ${result.response.text}`);

    await assertResponseSatisfies(prefix, {
      userMessage: turn.message,
      expectation: turn.expect.responseSatisfies,
      response: result.response.text,
      state,
    });
  }
}

async function assertResponseSatisfies(
  prefix: string,
  input: {
    userMessage: string;
    expectation: string;
    response: string;
    state: MaintenanceState | undefined;
  },
): Promise<void> {
  const judgement = await judgeResponse(input);

  assert(
    judgement.verdict === "pass",
    `${prefix}: response did not satisfy expectation ${JSON.stringify(input.expectation)}. ${judgement.reason}. Response: ${JSON.stringify(input.response)}`,
  );
}

async function judgeResponse(input: {
  userMessage: string;
  expectation: string;
  response: string;
  state: MaintenanceState | undefined;
}): Promise<z.infer<typeof ResponseJudgementSchema>> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await llm.structured({
        name: "maintenance_case_response_judge",
        instruction: `
Judge whether an assistant response semantically satisfies the scenario expectation.
Use meaning, not keyword matching. Accept equivalent wording, omissions that do not affect the business requirement, and natural phrasing variation.
The expectation for the current turn is the only response criterion. Do not add requirements from surrounding scenario names or other turns.
Fail only when the response contradicts the current-turn expectation, advances the workflow incorrectly, omits a required next action, or claims facts not supported by the provided workflow state.
Set verdict to "pass" when the response satisfies the expectation. Set verdict to "fail" only when your reason explains a concrete violation.
Return a short reason.
        `,
        schema: ResponseJudgementSchema,
        messages: [userMessage(JSON.stringify(input, null, 2))],
      });
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
  }

  throw lastError;
}

function userMessage(content: string) {
  return { role: "user" as const, content, timestamp: Date.now() };
}

function loadCases(): WorkflowCase[] {
  const yamlPath = resolve(dirname(fileURLToPath(import.meta.url)), "workflow.yaml");
  return WorkflowCasesFileSchema.parse(YAML.parse(readFileSync(yamlPath, "utf8"))).cases;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
