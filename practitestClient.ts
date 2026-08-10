type PractiTestConfig = {
  baseUrl: string;
  email: string;
  token: string;
  projectId: string;
  setId: string;
};

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

function authHeader(email: string, token: string) {
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  return { Authorization: `Basic ${auth}` };
}

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

/** Test Sets matching a saved PractiTest filter (the "automation queue" filter configured in the UI). */
export async function findQueuedTestSets(filterId: string, retries = 3): Promise<any[]> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/sets.json?filter-id=${encodeURIComponent(filterId)}`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data ?? [];
}

export async function getTestSet(setId: number | string, retries = 3): Promise<any> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/sets/${setId}.json`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data;
}

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

export async function getInstancesForSet(setId: number | string, retries = 3): Promise<any[]> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/instances.json?set-ids=${encodeURIComponent(
    String(setId)
  )}`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data ?? [];
}

export async function getTest(testId: number | string, retries = 3): Promise<any> {
  const cfg = getConfig();
  const url = `${cfg.baseUrl}/api/v2/projects/${cfg.projectId}/tests/${testId}.json`;
  const result = await requestWithRetry(url, { method: "GET" }, retries);
  return result?.data;
}
