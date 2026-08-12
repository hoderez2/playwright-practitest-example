// Playwright custom reporter: runs after every test and reports the result to
// PractiTest. It supports two modes, decided per-run by getQueueContext():
//
//  - Push mode (default): used by a plain `npm test` / the GitHub Actions
//    workflow. Reports via autoCreateRun(), which creates the Test/Instance/Run
//    in cfg.setId on the fly if they don't already exist.
//  - Queue mode: used when scripts/queueRunner.ts spawns this Playwright run.
//    It sets PT_QUEUE_SET_ID / PT_QUEUE_MAP_FILE so this reporter instead
//    reports each result into a specific, already-existing PractiTest Instance
//    via createRunForInstance() - see README's "Queue-based demo" section.
import * as fs from "fs";
import * as path from "path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { autoCreateRun, createRunForInstance, getConfig } from "./practitestClient";

type PractiTestAttachment = {
  filename: string;
  content_encoded: string;
};

type QueueContext = {
  setId: string;
  map: Record<string, number>;
};

function toRunDuration(ms = 0): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

// Builds a readable PractiTest test name from Playwright's describe/test title
// path, e.g. "PractiTest Demo Homepage loads". Drops the spec filename and the
// project name (e.g. "chromium") since neither is meaningful in PractiTest.
function getTestName(test: TestCase): string {
  const projectName = test.parent.project()?.name;
  return test.titlePath()
    .filter((part) => part && !part.endsWith(".spec.ts") && part !== projectName)
    .join(" ");
}

function getExitCode(status: TestResult["status"]): number {
  return status === "passed" ? 0 : 1;
}

function buildExecutionOutput(test: TestCase, result: TestResult): string {
  const testName = getTestName(test);

  if (result.status === "passed") {
    return `Playwright test passed: ${testName}`;
  }

  const parts = [
    `Playwright test failed: ${testName}`,
    `Status: ${result.status}`,
    `Duration: ${result.duration} ms`,
  ];

  if (result.error?.message) parts.push(`Error: ${result.error.message}`);
  if (result.error?.stack) parts.push(`Stack:\n${result.error.stack}`);

  return parts.join("\n\n");
}

function fileToAttachment(filePath: string): PractiTestAttachment | null {
  if (!fs.existsSync(filePath)) return null;

  return {
    filename: path.basename(filePath),
    content_encoded: fs.readFileSync(filePath).toString("base64"),
  };
}

let cachedQueueContext: QueueContext | null | undefined;

/** Non-null only when queueRunner.ts spawned this Playwright run (see scripts/queueRunner.ts). */
function getQueueContext(): QueueContext | null {
  if (cachedQueueContext !== undefined) return cachedQueueContext;

  const setId = process.env.PT_QUEUE_SET_ID;
  const mapFilePath = process.env.PT_QUEUE_MAP_FILE;
  if (!setId || !mapFilePath) {
    cachedQueueContext = null;
    return cachedQueueContext;
  }

  // queueRunner.ts writes this file before spawning Playwright: a JSON map of
  // automationId -> instanceId for every test it resolved. It's how the
  // instance-id map crosses the process boundary into this reporter.
  const map = JSON.parse(fs.readFileSync(mapFilePath, "utf8"));
  cachedQueueContext = { setId, map };
  return cachedQueueContext;
}

// Playwright tests are tagged `@pt-<automationId>` (see tests/example.spec.ts).
// This finds that tag and looks up the matching instance id from the queue map.
function resolveInstanceId(test: TestCase, map: Record<string, number>): number | undefined {
  const tag = test.tags.find((t) => t.startsWith("@pt-"));
  return tag ? map[tag.slice(4)] : undefined;
}

export default class PractiTestReporter implements Reporter {
  // Playwright does not guarantee onTestEnd's returned promise is fully
  // awaited before the process exits (especially with multiple reporters
  // registered). Track every in-flight report here and await them all in
  // onEnd, which Playwright does wait for.
  private pending: Promise<void>[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    // "skipped" (and any other status) isn't a real execution outcome worth
    // reporting to PractiTest.
    if (!["passed", "failed", "timedOut", "interrupted"].includes(result.status)) {
      return;
    }
    this.pending.push(this.reportResult(test, result));
  }

  async onEnd(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  private async reportResult(test: TestCase, result: TestResult): Promise<void> {
    const testName = getTestName(test);
    // Screenshots (and, on retry, trace files) are only attached for non-passing
    // results - no point sending evidence for a test that just passed.
    const attachments =
      result.status !== "passed"
        ? result.attachments
            .filter((attachment) => attachment.path)
            .map((attachment) => fileToAttachment(attachment.path!))
            .filter((attachment): attachment is PractiTestAttachment => Boolean(attachment))
        : [];

    const attributes = {
      "exit-code": getExitCode(result.status),
      "run-duration": toRunDuration(result.duration),
      "automated-execution-output": buildExecutionOutput(test, result),
    };
    const filesBlock = attachments.length > 0 ? { files: { data: attachments } } : {};

    const queueContext = getQueueContext();
    if (queueContext) {
      // Queue mode: report into the specific instance queueRunner.ts already
      // resolved for this test, instead of auto-creating a new one.
      const instanceId = resolveInstanceId(test, queueContext.map);
      if (!instanceId) {
        // Can happen if the config-level grep filter (playwright.config.ts's
        // queueGrep()) matched a test with no corresponding queue-map entry.
        // Log and move on rather than failing the whole run over it.
        console.warn(`PractiTest queue mode: no instance mapping for "${testName}", skipping report.`);
        return;
      }

      const payload = {
        data: {
          type: "instances",
          attributes: { "instance-id": instanceId, ...attributes },
          ...filesBlock,
        },
      };

      try {
        await createRunForInstance(payload);
        console.log(`PractiTest run created for instance ${instanceId}: ${testName}`);
      } catch (error) {
        // Deliberately not re-thrown: one failed report call shouldn't abort
        // the rest of the run. Matters most when retries are enabled (real CI
        // sets `retries: 2` in playwright.config.ts), since a persistently
        // failing test then triggers this call multiple times in a row.
        console.error(`PractiTest reporting failed for "${testName}" (instance ${instanceId}):`);
        console.error(error);
      }
      return;
    }

    // Push mode (default): auto-create the Test/Instance/Run in cfg.setId.
    const cfg = getConfig();
    const payload = {
      data: {
        type: "instances",
        attributes: { "set-id": Number(cfg.setId), ...attributes },
        "test-attributes": {
          name: testName,
          "custom-fields": {
            "---f-278185": "Automated", // "Automation Status" field on the Test entity.
          },
        },
        ...filesBlock,
      },
    };

    try {
      await autoCreateRun(payload);
      console.log(`PractiTest run created: ${testName}`);
    } catch (error) {
      console.error(`PractiTest reporting failed for "${testName}":`);
      console.error(error);
    }
  }
}
