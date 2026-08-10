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

function fieldKey(fieldId: string): string {
  return `---f-${fieldId}`;
}

function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  return false;
}

function getCustomField(entity: any, fieldId: string): unknown {
  return entity?.attributes?.["custom-fields"]?.[fieldKey(fieldId)];
}

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([\w-]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

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

function assertAutomationRequested(testSet: any, queueCfg: QueueConfig): void {
  const value = getCustomField(testSet, queueCfg.automationRequestedFieldId);
  if (!isTruthy(value)) {
    throw new Error(
      `Test set #${testSet.id} does not have "Automation Requested" checked (value: ${JSON.stringify(value)}).`
    );
  }
}

function extractTestId(instance: any): string | undefined {
  return instance?.attributes?.["test-id"] ?? instance?.relationships?.test?.data?.id;
}

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

function writeMapFile(map: Record<string, number>): string {
  const dir = path.join(process.cwd(), ".pt-queue");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `queue-${Date.now()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2));
  return filePath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildGrepPattern(automationIds: string[]): string {
  return `@pt-(${automationIds.map(escapeRegExp).join("|")})`;
}

function runPlaywright(grep: string, extraEnv: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["playwright", "test", "--grep", grep], {
      stdio: "inherit",
      // Force CI-like behavior: without it, Playwright's HTML reporter opens a
      // blocking local report server on failure, which would hang this script.
      env: { ...process.env, CI: "1", ...extraEnv },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  const queueCfg = getQueueConfig();

  const testSet = await resolveTestSet(args, queueCfg);
  const setId = testSet.id;
  console.log(`Claiming test set #${setId} ("${testSet.attributes?.name ?? "unnamed"}")...`);
  assertAutomationRequested(testSet, queueCfg);

  const statusField = fieldKey(queueCfg.automationQueueStatusFieldId);

  await updateTestSetFields(setId, { [statusField]: "Claimed" });
  console.log("Test Set status: Queued -> Claimed");

  console.log("Fetching instances...");
  const instances = await getInstancesForSet(setId);
  const map = await buildAutomationIdMap(instances, queueCfg);
  const mappedCount = Object.keys(map).length;
  console.log(
    `Resolved ${mappedCount}/${instances.length} tests to automation IDs: ${Object.keys(map).join(", ") || "none"}`
  );

  if (mappedCount === 0) {
    await updateTestSetFields(setId, { [statusField]: "Failed" });
    console.error("No tests in this set had a matching Automation ID. Marked Failed.");
    process.exit(1);
  }

  await updateTestSetFields(setId, { [statusField]: "Running" });
  console.log("Test Set status: Claimed -> Running");

  const mapFilePath = writeMapFile(map);
  const grep = buildGrepPattern(Object.keys(map));
  console.log(`Running: npx playwright test --grep "${grep}"`);

  let exitCode = 1;
  try {
    exitCode = await runPlaywright(grep, {
      PT_QUEUE_SET_ID: String(setId),
      PT_QUEUE_MAP_FILE: mapFilePath,
    });
  } finally {
    fs.rmSync(mapFilePath, { force: true });
  }

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
