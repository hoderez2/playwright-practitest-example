# Playwright + PractiTest API Example

This project shows how to run Playwright tests and report the results to PractiTest using the `auto_create` API endpoint.

It also includes a second, opt-in mode where PractiTest drives the automation as a queue instead - see [Queue-based demo (pull model)](#queue-based-demo-pull-model) further down.

## What this example does

- Runs Playwright tests from the command line
- Reports each test result to PractiTest
- Uses the PractiTest `auto_create` endpoint
- Automatically creates the test in PractiTest if it does not exist
- Automatically creates the instance in the Test Set if needed
- Creates the run in that instance
- Attaches failure screenshots to failed runs

## Installation

```bash
npm install
npx playwright install
```

## Environment setup

Create a `.env` file from the provided example:

```bash
cp .env.example .env
```

Then update it with your PractiTest details:

```env
PT_BASE_URL=https://api.practitest.com
PT_EMAIL=your@email.com
PT_TOKEN=your_api_token
PT_PROJECT_ID=12345
PT_SET_ID=67890
```

## Running the example

```bash
npm test
```

To run only the demo spec:

```bash
npm run test:demo
```

## How it works

When Playwright finishes a test, the custom reporter receives `onTestEnd`, builds a PractiTest `auto_create` payload, and posts the result to PractiTest.

PractiTest then:

- Creates the test if it does not exist
- Creates an instance of that test in the configured Test Set
- Creates a new run in that instance

If the test failed, Playwright's failure screenshot attachments are sent with the run.

## Key files

**`practitestClient.ts`**
Handles authenticated API calls to PractiTest and wraps the `auto_create` endpoint.

**`practitestReporter.ts`**
Builds the payload, collects failed-test screenshots, and reports results through Playwright's custom reporter API.

**`tests/example.spec.ts`**
A sample Playwright spec with passing and intentionally failing coverage.

## Custom fields

This integration sets the following custom field on every test it creates via `auto_create`:

| Field name | Field ID | Value |
|---|---|---|
| Automation Status | 278185 | `Automated` |

The field is applied in `practitestReporter.ts` inside `test-attributes`:

```ts
"custom-fields": {
  "---f-278185": "Automated",
}
```

Custom field keys follow the PractiTest API format `---f-{field_id}`. The value must match exactly one of the field's configured possible values.

## Test naming

Test names are built from Playwright's title path so they include surrounding `describe` blocks when present. This helps avoid name collisions and keeps tests traceable.

## CI / GitHub Actions

The included workflow (`.github/workflows/playwright.yml`) runs on every push or pull request to `main`/`master`, and can also be triggered manually.

Add the following secrets to your GitHub repository (**Settings → Secrets and variables → Actions**):

| Secret | Description |
|---|---|
| `PT_EMAIL` | Your PractiTest account email |
| `PT_TOKEN` | Your PractiTest API token |
| `PT_PROJECT_ID` | The numeric ID of your PractiTest project |
| `PT_SET_ID` | The numeric ID of the Test Set to report into |

## Queue-based demo (pull model)

Alongside the push flow above (CI runs everything on every push), this repo also has a **pull/queue mode** where PractiTest is the orchestration layer: a tester queues a Test Set in PractiTest, and an automation worker polls, claims it, runs only the mapped tests, and reports results back into the pre-existing instances (not auto-created) - full traceability, no manual triggering. This is additive: `npm test` / the GitHub Actions workflow are unaffected.

See [docs/practitest-automation-queue.md](docs/practitest-automation-queue.md) for the full design rationale behind this model. What follows here is how it's implemented (demo-scoped) in this repo.

### Custom fields required

| Field name | Entity | Type | Notes |
|---|---|---|---|
| Automation Requested | Test Set | Checkbox | Checked = eligible for automated pickup |
| Automation Queue Status | Test Set | List | Values: `Queued`, `Claimed`, `Running`, `Completed`, `Failed` |
| Automation ID | Test | Text | Stable identifier, matched against a Playwright test's `@pt-<id>` tag - independent of test name |

> **Naming note:** this repo already has a *Test*-level field called "Automation Status" (field `278185`, see [Custom fields](#custom-fields) above, always set to `Automated`). The queue field above is deliberately named **"Automation Queue Status"** to avoid confusion - different entity, different purpose, different values.

Create these in PractiTest under **Settings → Customization → Custom Fields**, then set up a saved filter over Test Sets for `Automation Requested = true AND Automation Queue Status = Queued` - this is the "automation queue" the worker polls against. Note each field's numeric ID and the filter's ID for the env vars below.

### Env vars

```env
PT_QUEUE_FILTER_ID=99999
PT_TESTSET_AUTOMATION_REQUESTED_FIELD_ID=111111
PT_TESTSET_AUTOMATION_QUEUE_STATUS_FIELD_ID=111112
PT_TEST_AUTOMATION_ID_FIELD_ID=111113
```

### Mapping tests

The 4 tests in `tests/example.spec.ts` are tagged `@pt-home-loads`, `@pt-intentional-failure`, `@pt-public-access`, `@pt-password-security`. Set each corresponding Test's "Automation ID" field in PractiTest to the same string, minus the `@pt-` prefix (e.g. `home-loads`).

### Running it

```bash
npm run queue:run
# or target a specific Test Set directly:
npm run queue:run -- --set-id=4721722
```

One invocation does a single find → claim → run → report → complete cycle: it finds a queued Test Set (via the saved filter, or `--set-id`), flips its status to `Claimed`, resolves each instance's Test to an Automation ID, flips status to `Running`, runs only the matching Playwright tests, reports each result into its existing instance via `runs.json` + `instance-id` (as opposed to `auto_create`), and flips status to `Completed`/`Failed` based on the outcome. This is a one-shot script rather than a background poller, by design - reliable to trigger and narrate live; a continuous loop is a natural next step (wrap the same logic in an interval).

**Test filtering:** which tests run is decided by `playwright.config.ts`'s `grep` option, not a `--grep` CLI flag. `queueRunner.ts` writes the automationId → instanceId map to a temp file and passes its path via `PT_QUEUE_MAP_FILE`; `playwright.config.ts`'s `queueGrep()` reads that file at config-load time and builds the filter `RegExp` in-process. This matters at scale: a `--grep` value built from hundreds or thousands of automation IDs can hit OS command-line length limits (Windows caps a process's command line around 32K characters), while building the same `RegExp` in-process has no such limit.

**Note:** the `html` reporter is configured with `open: 'never'` in `playwright.config.ts`, so it never opens a blocking local report server on failure - this used to be worked around by forcing `CI=1` on the spawned process, which had the unwanted side effect of also enabling `playwright.config.ts`'s `retries: 2` and forcing `workers: 1` (sequential execution) under CI. Fixing the reporter directly means `queue:run` now runs with real parallelism and the same retry behavior as `npm test`, rather than an artificially CI-like environment.

### Key files (queue mode)

**`scripts/queueRunner.ts`**
The one-shot orchestrator described above.

**`practitestClient.ts`**
Also exports the queue-mode API functions: `findQueuedTestSets`, `getTestSet`, `updateTestSetFields`, `getInstancesForSet`, `getTest`, `createRunForInstance`.

**`practitestReporter.ts`**
When `PT_QUEUE_SET_ID`/`PT_QUEUE_MAP_FILE` are set (by `queueRunner.ts`), it reports into the specific pre-existing instance via `createRunForInstance` instead of `auto_create`. Without those variables set, it uses the original `auto_create` behavior, so a plain `npm test` is unaffected.

## References

- [PractiTest API v2 - auto_create endpoint](https://www.practitest.com/api-v2/#auto-create-a-run)
- [Playwright custom reporters](https://playwright.dev/docs/test-reporters)
- [Playwright test tags](https://playwright.dev/docs/test-annotations#tag-tests)
