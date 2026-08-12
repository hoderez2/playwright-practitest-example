// One-shot orchestrator for the "queue/pull model" demo (see
// docs/practitest-automation-queue.md for the concept, and the README's
// "Queue-based demo (pull model)" section for how this fits together).
//
// Each run of `npm run queue:run` does a single find -> claim -> run -> report
// -> complete cycle:
//   1. Find a queued Test Set (via the saved PractiTest filter, or --set-id).
//   2. Claim it (Automation Queue Status: Queued -> Claimed).
//   3. Resolve each Instance in the set to a Playwright test, via the stable
//      "Automation ID" custom field on each Test.
//   4. Run only those Playwright tests (Automation Queue Status -> Running).
//      The filtering itself happens in playwright.config.ts's queueGrep(),
//      not here - see the comment there for why (avoids OS command-line
//      length limits, which a `--grep` CLI arg would eventually hit at scale).
//   5. Report results back into the existing instances (practitestReporter.ts
//      does this, in "queue mode"), then mark the set Completed/Failed.
//
// This is intentionally one-shot rather than a background poller - reliable
// to trigger and narrate live for a demo. A continuous loop is a natural
// follow-up: wrap main() in an interval and keep the same steps.
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import {
  findQueuedTestSets,
  getInstancesForSet,
  getQueueConfig,
  getTest,
  getTestSet,
  updateTestSetFields,
  type QueueConfig,
} from "../practitestClient";

// PractiTest custom fields are addressed as `---f-{field_id}` in API payloads.
function fieldKey(fieldId: string): string {
  return `---f-${fieldId}`;
}

// PractiTest's wire format for a checkbox custom field isn't pinned down here
// (could come back as a real boolean, "1"/"0", or "Yes"/"No" depending on
// account/version) - this accepts the common variants rather than assuming one.
function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  return false;
}

function getCustomField(entity: any, fieldId: string): unknown {
  return entity?.attributes?.["custom-fields"]?.[fieldKey(fieldId)];
}

// Supports `--set-id=NNN` and `--filter-id=NNN` overrides on the command line.
function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([\w-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

// Step 1: find the Test Set to process. --set-id bypasses the queue entirely
// (useful for demos/debugging a specific set); otherwise this is the actual
// "poll" - ask PractiTest for whatever the saved filter currently matches
// and take the first result.
async function resolveTestSet(args: Record<string, string>, queueCfg: QueueConfig): Promise<any> {
  if (args["set-id"]) {
    const testSet = await getTestSet(args["set-id"]);
    if (!testSet) throw new Error(`Test set ${args["set-id"]} not found.`);
    return testSet;
  }

  const filterId = args["filter-id"] ?? queueCfg.filterId;
  console.log(`Polling PractiTest filter #${filterId} for queued test sets...`);
  const candidates = await findQueuedTestSets(filterId);
  if (candidates.length === 0) {
    console.log("No queued test sets found. Nothing to do.");
    process.exit(0);
  }
  return candidates[0];
}

// Defensive guard: the saved filter should already only return sets with
// Automation Requested checked, but this fails loudly if a --set-id override
// points at a set that never opted in, rather than silently processing it.
function assertAutomationRequested(testSet: any, queueCfg: QueueConfig): void {
  const value = getCustomField(testSet, queueCfg.automationRequestedFieldId);
  if (!isTruthy(value)) {
    throw new Error(
      `Test set #${testSet.id} does not have "Automation Requested" checked (value: ${JSON.stringify(value)}).`
    );
  }
}

// The exact shape of an Instance's reference to its parent Test wasn't fully
// confirmed against PractiTest's docs, so this tries both plausible spots.
function extractTestId(instance: any): string | undefined {
  return instance?.attributes?.["test-id"] ?? instance?.relationships?.test?.data?.id;
}

// Step 3: for every Instance in the set, look up its parent Test's
// "Automation ID" field and build automationId -> instanceId. One extra API
// call per instance (getTest) since the instances list doesn't embed it -
// fine at demo scale, would need batching for a larger Test Set in production.
async function buildAutomationIdMap(instances: any[], queueCfg: QueueConfig): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  for (const instance of instances) {
    const testId = extractTestId(instance);
    if (!testId) continue;

    const test = await getTest(testId);
    const automationId = getCustomField(test, queueCfg.automationIdFieldId);
    if (typeof automationId === "string" && automationId.trim()) {
      map[automationId.trim()] = Number(instance.id);
    }
  }
  return map;
}

// Writes the automationId -> instanceId map to a temp JSON file so it can
// cross the process boundary into the spawned Playwright run (env vars can't
// carry a structured object) - practitestReporter.ts reads this back via
// PT_QUEUE_MAP_FILE. Caller is responsible for deleting it after the run.
function writeMapFile(map: Record<string, number>): string {
  const dir = path.join(process.cwd(), ".pt-queue");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `queue-${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2));
  return filePath;
}

// Step 4: run the mapped tests in a child process. No --grep argument here -
// playwright.config.ts's queueGrep() reads PT_QUEUE_MAP_FILE (set via extraEnv
// below) and builds the same filter in-process instead, so there's no OS
// command-line length limit to worry about as the test count grows.
function runPlaywright(extraEnv: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["playwright", "test"], {
      stdio: "inherit",
      // Force CI-like behavior: without it, Playwright's HTML reporter opens a
      // blocking local report server on failure, which would hang this script.
      // Side effect: playwright.config.ts's `retries: process.env.CI ? 2 : 0`
      // also kicks in under this flag (see README's queue-mode note).
      env: { ...process.env, CI: "1", ...extraEnv },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const queueCfg = getQueueConfig();

  // --- Step 1: find + step 2: claim ---
  const testSet = await resolveTestSet(args, queueCfg);
  const setId = testSet.id;
  console.log(`Claiming test set #${setId} ("${testSet.attributes?.name ?? "unnamed"}")...`);
  assertAutomationRequested(testSet, queueCfg);

  const statusField = fieldKey(queueCfg.automationQueueStatusFieldId);

  await updateTestSetFields(setId, { [statusField]: "Claimed" });
  console.log("Test Set status: Queued -> Claimed");

  // --- Step 3: resolve which Playwright tests this set maps to ---
  console.log("Fetching instances...");
  const instances = await getInstancesForSet(setId);
  const map = await buildAutomationIdMap(instances, queueCfg);
  const mappedCount = Object.keys(map).length;
  console.log(
    `Resolved ${mappedCount}/${instances.length} tests to automation IDs: ${Object.keys(map).join(", ") || "none"}`
  );

  if (mappedCount === 0) {
    // Nothing to run - likely a missing/blank "Automation ID" field on every
    // Test in the set. Mark Failed rather than leaving it stuck in Claimed.
    await updateTestSetFields(setId, { [statusField]: "Failed" });
    console.error("No tests in this set had a matching Automation ID. Marked Failed.");
    process.exit(1);
  }

  // --- Step 4: run ---
  await updateTestSetFields(setId, { [statusField]: "Running" });
  console.log("Test Set status: Claimed -> Running");

  const mapFilePath = writeMapFile(map);
  console.log(`Running: npx playwright test (filtered to ${mappedCount} mapped tests via playwright.config.ts)`);

  let exitCode = 1;
  try {
    exitCode = await runPlaywright({
      PT_QUEUE_SET_ID: String(setId),
      PT_QUEUE_MAP_FILE: mapFilePath,
    });
  } finally {
    fs.rmSync(mapFilePath, { force: true });
  }

  // --- Step 5: report was handled by practitestReporter.ts during the run;
  // just mark the set's final state here ---
  const finalStatus = exitCode === 0 ? "Completed" : "Failed";
  await updateTestSetFields(setId, { [statusField]: finalStatus });
  console.log(`Test Set status: Running -> ${finalStatus}`);

  process.exit(exitCode);
}

main().catch((error) => {
  console.error("Queue runner failed:");
  console.error(error);
  process.exit(1);
});
