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

  const map = JSON.parse(fs.readFileSync(mapFilePath, "utf8"));
  cachedQueueContext = { setId, map };
  return cachedQueueContext;
}

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
      const instanceId = resolveInstanceId(test, queueContext.map);
      if (!instanceId) {
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
        console.error(`PractiTest reporting failed for "${testName}" (instance ${instanceId}):`);
        console.error(error);
      }
      return;
    }

    const cfg = getConfig();
    const payload = {
      data: {
        type: "instances",
        attributes: { "set-id": Number(cfg.setId), ...attributes },
        "test-attributes": {
          name: testName,
          "custom-fields": {
            "---f-278185": "Automated",
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
