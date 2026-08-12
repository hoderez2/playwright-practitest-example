// Thin HTTP client for PractiTest's API v2 (https://www.practitest.com/api-v2/).
//
// Two ways results get reported into PractiTest, both built on requestWithRetry below:
//  - Push mode (autoCreateRun): the original flow. Every `npm test` run posts to
//    `runs/auto_create.json`, which creates the Test/Instance/Run on the fly if
//    they don't already exist. Used when no queue context is present.
//  - Queue mode (createRunForInstance + the other functions here): used by
//    scripts/queueRunner.ts. The Test/Instance already exist in PractiTest, so
//    this posts a Run directly against a known instance-id instead of auto-creating.
//
// PractiTest custom fields are addressed in request bodies as `---f-{field_id}`
// (see the "---f-278185" example in practitestReporter.ts, and fieldKey() in
// scripts/queueRunner.ts for the queue-mode fields).

type PractiTestConfig = {
  baseUrl: string;
  email: string;
  token: string;
  projectId: string;
  setId: string;
};

// Only required for queue mode (scripts/queueRunner.ts) - a plain `npm test`
// never calls getQueueConfig(), so these env vars aren't needed for the push flow.
export type QueueConfig = {
  filterId: string;
  automationRequestedFieldId: string;
  automationQueueStatusFieldId: string;
  automationIdFieldId: string;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function getConfig(): PractiTestConfig {
  return {
    baseUrl: getRequiredEnv("PT_BASE_URL").replace(/\/$/, ""),
    email: getRequiredEnv("PT_EMAIL"),
    token: getRequiredEnv("PT_TOKEN"),
    projectId: getRequiredEnv("PT_PROJECT_ID"),
    setId: getRequiredEnv("PT_SET_ID"),
  };
}

export function getQueueConfig(): QueueConfig {
  return {
    filterId: getRequiredEnv("PT_QUEUE_FILTER_ID"),
    automationRequestedFieldId: getRequiredEnv("PT_TESTSET_AUTOMATION_REQUESTED_FIELD_ID"),
    automationQueueStatusFieldId: getRequiredEnv("PT_TESTSET_AUTOMATION_QUEUE_STATUS_FIELD_ID"),
    automationIdFieldId: getRequiredEnv("PT_TEST_AUTOMATION_ID_FIELD_ID"),
  };
}

// PractiTest authenticates with HTTP Basic auth: base64("email:api_token").
function authHeader(email: string, token: string) {
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  return { Authorization: `Basic ${auth}` };
}

// Shared fetch wrapper for every PractiTest call below. Retries on HTTP 429
// (rate limited) with a fixed backoff schedule; any other non-2xx status
// throws immediately. Every function in this file goes through here so
// retry/auth/error-handling behavior stays consistent.
async function requestWithRetry(url: string, init: RequestInit, retries = 3): Promise<any> {
  const cfg = getConfig();
  const retryDelays = [15000, 30000];

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeader(cfg.email, cfg.token),
        ...init.headers,
      },
    });

    if (response.ok) {
      return response.status === 204 ? null : response.json();
    }

    const body = await response.text();
    if (response.status === 429 && attempt < retries) {
      const delay = retryDelays[attempt - 1] ?? retryDelays[retryDelays.length - 1];
      console.warn(
        `PractiTest rate limited (429). Retrying in ${delay / 1000}s... (attempt ${attempt}/${retries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    throw new Error(`PractiTest request failed ${response.status} (${init.method ?? "GET"} ${url}): ${body}`);
  }
}

// Push mode: creates the Test, Instance (in cfg.setId), and Run in one call if
// they don't already exist. This is what a plain `npm test` uses.
export async function autoCreateRun(payload: unknown, retries = 3) {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/runs/auto_create.json`;
  return requestWithRetry(url, { method: "POST", body: JSON.stringify(payload) }, retries);
}

/** Creates a run under an already-existing instance (payload.data.attributes["instance-id"] required), as opposed to autoCreateRun which also creates the test/instance. */
export async function createRunForInstance(payload: unknown, retries = 3) {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/runs.json`;
  return requestWithRetry(url, { method: "POST", body: JSON.stringify(payload) }, retries);
}

/**
 * Test Sets matching a saved PractiTest filter (the "automation queue" filter
 * configured in the UI - see docs/practitest-automation-queue.md). This is the
 * "poll" step: queueRunner.ts calls this to find work, relying on the filter's
 * own criteria (e.g. Automation Requested = true AND Automation Queue Status =
 * Queued) rather than filtering client-side.
 */
export async function findQueuedTestSets(filterId: string, retries = 3): Promise<any[]> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/sets.json?filter-id=${encodeURIComponent(filterId)}`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data ?? [];
}

// Fetches one Test Set by id, including its custom-fields (used to check
// "Automation Requested" and read the current queue status).
export async function getTestSet(setId: number | string, retries = 3): Promise<any> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/sets/${setId}.json`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data;
}

// Writes one or more custom-field values on a Test Set, e.g. moving
// "Automation Queue Status" through Claimed -> Running -> Completed/Failed.
// customFields keys must already be in `---f-{field_id}` form (see fieldKey()
// in scripts/queueRunner.ts).
export async function updateTestSetFields(
  setId: number | string,
  customFields: Record<string, unknown>,
  retries = 3
): Promise<any> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/sets/${setId}.json`;
  const payload = {
    data: {
      type: "sets",
      attributes: {
        "custom-fields": customFields,
      },
    },
  };
  return requestWithRetry(url, { method: "PUT", body: JSON.stringify(payload) }, retries);
}

// All Instances belonging to a Test Set. Each instance references its parent
// Test (see extractTestId() in scripts/queueRunner.ts), which is looked up
// separately via getTest() below to read its "Automation ID" custom field.
export async function getInstancesForSet(setId: number | string, retries = 3): Promise<any[]> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/instances.json?set-ids=${encodeURIComponent(
    String(setId)
  )}`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data ?? [];
}

// Fetches one Test by id, including its custom-fields (used to read
// "Automation ID", the stable identifier matched against a Playwright test's
// `@pt-<id>` tag).
export async function getTest(testId: number | string, retries = 3): Promise<any> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/tests/${testId}.json`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data;
}
