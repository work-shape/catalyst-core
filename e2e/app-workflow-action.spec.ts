import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// A button of a published App starts a published Workflow through a named action: the frame
// asks the interface, the instance starts the Workflow as whoever looks, and the App follows
// the run with the kit's `useWorkflowRun` until it shows what the Workflow answered. A member
// who may use the App and not the Workflow starts it as well: the App is the gate, and its
// publisher was asked the right (DP-1b; before it, the member was refused). The draft of
// the App starts a test run (DP-1): of the published Workflow for a tester who may only use
// it, of its draft for one who may write it, marked over the frame, and no live run. Fails
// without APP-6a: no action could name a Workflow, and kit 1.3.0, which follows a run, did not
// exist. The draft's part fails before DP-1, when the draft started nothing.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The people of this spec, from `tests/fixtures/e2e-users/app-workflow-action.yaml`. */
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const builder = { email: "e2e-app-workflow@example.test", password: "e2e-app-workflow-password" };
const member = {
  email: "e2e-app-workflow-member@example.test",
  password: "e2e-app-workflow-member-password"
};

const idSchema = z.object({ id: z.string() });
const assetSchema = z.looseObject({ id: z.string(), revision: z.number() });

async function signIn(page: Page, person: { email: string; password: string }): Promise<string> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The instance knows a person of the config from their first call on.
  const me = await page.request.get(`${apiOrigin}/api/v1/me`);
  expect(me.ok()).toBe(true);
  return idSchema.parse(await me.json()).id;
}

/**
 * Stores and publishes, as the release would, a Workflow that starts by hand and answers the
 * page it is given. Answers the id of its asset.
 */
async function publishWorkflow(root: Page, id: string): Promise<string> {
  const runAs = `${id}-runner`;
  const principal = await requestWithOrigin(
    root,
    "post",
    `${apiOrigin}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const assetUrl = `${apiOrigin}/api/v1/assets/workflow/${id}`;
  const saved = await requestWithOrigin(root, "put", assetUrl, {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          id,
          name: "Visit log",
          description: "Logs the visit of a page that an App names.",
          runAs,
          inputs: {
            type: "object",
            properties: { page: { type: "string" }, source: { type: "string" } },
            additionalProperties: false
          },
          outputs: {
            type: "object",
            properties: { page: { type: "string" }, source: { type: "string" } },
            required: ["page"]
          },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "result",
              name: "Result",
              type: "output",
              input: {
                page: { ref: { step: "start", path: "input.page" } },
                source: { ref: { step: "start", path: "input.source" } }
              }
            }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const stored = assetSchema.parse(await (await root.request.get(assetUrl)).json());
  const published = await requestWithOrigin(root, "post", `${assetUrl}/publish`, {
    data: { revision: stored.revision }
  });
  expect(published.ok(), await published.text()).toBe(true);
  return stored.id;
}

/** The source of the App: one button that starts the Workflow and shows what it answered. */
function appSource(app: { id: string; workflow: string; heading: string }): Record<string, string> {
  return {
    "app.yaml": `id: ${app.id}\nname: Visit log\nkit: 1.3.0\n`,
    "actions/log-visit.action.yaml": `workflow: ${app.workflow}
description: Logs the visit of a page.
input:
  schema:
    type: object
    properties:
      page: { type: string }
    required: [page]
  mapping:
    page: "{{page}}"
    source: app
`,
    "src/routes/__root.tsx": `import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <Outlet />
    </main>
  )
});
`,
    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  actions,
  AppCallError,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  useWorkflowRun
} from "@work-shape/catalyst-app-kit";

type Answer =
  | { state: "idle" }
  | { state: "started"; runId: string }
  | { state: "dry_run"; message: string }
  | { state: "refused"; message: string };

function runIdOf(result: unknown): string | undefined {
  return typeof result === "object" && result !== null && "id" in result &&
    typeof result.id === "string"
    ? result.id
    : undefined;
}

function Run({ runId }: { runId: string }) {
  const { run, error } = useWorkflowRun(runId);
  if (error) {
    return <Banner tone="warning">{error.message}</Banner>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p data-testid="run-status">{run?.status ?? "starting"}</p>
      {run?.status === "done" ? (
        <pre data-testid="run-output">{JSON.stringify(run.output)}</pre>
      ) : null}
    </div>
  );
}

function Visits() {
  const [answer, setAnswer] = useState<Answer>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const logVisit = () => {
    setBusy(true);
    actions
      .call(
        "log-visit",
        { page: "/pricing" },
        { idempotencyKey: \`visit-\${Date.now()}-\${Math.random().toString(36).slice(2)}\` }
      )
      .then((called) => {
        if (called.status === "dry_run") {
          setAnswer({ state: "dry_run", message: called.message });
          return;
        }
        const runId = runIdOf(called.result);
        setAnswer(runId ? { state: "started", runId } : { state: "idle" });
      })
      .catch((error: unknown) => {
        // The sentence is the platform's. The App shows it as it is.
        setAnswer({
          state: "refused",
          message: error instanceof AppCallError ? error.message : "The visit was not logged."
        });
      })
      .finally(() => setBusy(false));
  };
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>${app.heading}</CardTitle>
        <Button size="sm" loading={busy} onClick={logVisit}>
          Log visit
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {answer.state === "refused" ? (
          <div data-testid="refusal">
            <Banner tone="warning">{answer.message}</Banner>
          </div>
        ) : null}
        {answer.state === "dry_run" ? (
          <div data-testid="dry-run">
            <Banner tone="info">{answer.message}</Banner>
          </div>
        ) : null}
        {answer.state === "started" ? <Run runId={answer.runId} /> : null}
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/")({ component: Visits });
`
  };
}

/** The App inside the frame of the App's own screen or of its draft. */
function appIn(page: Page, screen: "app-view" | "app-edit"): FrameLocator {
  return page
    .getByTestId(screen)
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe");
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

// The test writes grants: it takes its turn with the tests that count grants.
test("an App button starts a published Workflow and shows its output, also to a member who may not use the Workflow; the draft starts a test run", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  accessState: _accessState
}, testInfo) => {
  // An App's id is taken once for the whole instance, so a repeated or retried run names its
  // App and its Workflow after the attempt.
  const suffix = randomUUID().slice(0, 8);
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const appId = attempt === 0 ? "visit-log" : `visit-log-${attempt}`;
  const workflow = `app-visit-${suffix}`;
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);

  const rootContext = await browser.newContext({ baseURL });
  await pageErrors.watch(rootContext);
  const root = await rootContext.newPage();
  await signIn(root, superadmin);
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(30_000);
  const builderId = await signIn(page, builder);
  await signIn(memberPage, member);
  const grants: string[] = [];

  try {
    const workflowAssetId = await publishWorkflow(root, workflow);
    // The builder, who publishes the App, may start this one Workflow; the member may not.
    const granted = await requestWithOrigin(
      root,
      "post",
      `${apiOrigin}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: builderId,
          action: "workflow.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: workflowAssetId
        }
      }
    );
    expect(granted.ok(), await granted.text()).toBe(true);
    grants.push(idSchema.parse(await granted.json()).id);

    // The workspace of the spec, its member, and the App, written and published by the builder.
    const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
      data: { name: `Visit team ${suffix}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: member.email } }
    );
    expect(added.ok(), await added.text()).toBe(true);
    const appUrl = `${apiOrigin}/api/v1/assets/app/${appId}`;
    const write = (heading: string, expectedRevision: number | null) =>
      requestWithOrigin(page, "put", appUrl, {
        data: {
          workspaceId,
          expectedRevision,
          files: Object.entries(appSource({ id: appId, workflow, heading })).map(
            ([path, text]) => ({ path, text })
          )
        },
        timeout: 90_000
      });
    const written = await write("Visit log", null);
    expect(written.ok(), await written.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${appUrl}/publish`, {
      data: { workspaceId, revision: 1, audience: "workspace" }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const appPath = `/w/${workspaceId}/apps/${appId}`;

    // The builder's button starts the Workflow, and the App follows the run to its output.
    await page.goto(appPath);
    const app = appIn(page, "app-view");
    await app.getByRole("button", { name: "Log visit" }).click();
    await expect(app.getByTestId("run-status")).toHaveText("done");
    await expect(app.getByTestId("run-output")).toHaveText('{"page":"/pricing","source":"app"}');
    await shoot(page, "app-workflow-action-done");
    // The run is the builder's, of this Workflow.
    const runs = await root.request.get(`${apiOrigin}/api/v1/workflows/${workflow}/runs`);
    expect(runs.ok(), await runs.text()).toBe(true);
    const listed = z
      .object({
        items: z.array(
          z.looseObject({ status: z.string(), startedBy: z.looseObject({ id: z.string() }) })
        )
      })
      .parse(await runs.json()).items;
    expect(listed).toEqual([
      expect.objectContaining({
        status: "done",
        startedBy: expect.objectContaining({ id: builderId })
      })
    ]);

    // The member may use the App and not the Workflow: the App is the gate, so the run starts.
    await memberPage.goto(appPath);
    const memberApp = appIn(memberPage, "app-view");
    await memberApp.getByRole("button", { name: "Log visit" }).click();
    await expect(memberApp.getByTestId("run-status")).toHaveText("done");
    await expect(memberApp.getByTestId("refusal")).toHaveCount(0);
    await shoot(memberPage, "app-workflow-action-member");

    // A draft starts a test run, of the Workflow's draft, since the builder, an admin, may
    // write the Workflow.
    const drafted = await write("Visit log draft", 1);
    expect(drafted.ok(), await drafted.text()).toBe(true);
    await page.goto(`/w/${workspaceId}/app-drafts/${appId}`);
    const draft = appIn(page, "app-edit");
    await expect(draft.getByText("Visit log draft")).toBeVisible();
    await draft.getByRole("button", { name: "Log visit" }).click();
    await expect(draft.getByTestId("run-status")).toHaveText("done");
    await expect(draft.getByTestId("run-output")).toHaveText('{"page":"/pricing","source":"app"}');
    await expect(draft.getByTestId("dry-run")).toHaveCount(0);
    const strip = page.getByTestId("app-edit").getByTestId("frame-test-run");
    await expect(strip).toContainText("Test run of the draft · Workflow draft");
    await shoot(page, "app-workflow-action-draft");
    const runsSchema = z.object({
      items: z.array(
        z.looseObject({
          id: z.string(),
          mode: z.string(),
          startedFrom: z.looseObject({ app: z.string(), workflowRevision: z.string() }).optional()
        })
      )
    });
    const readRuns = async () =>
      runsSchema.parse(
        await (await root.request.get(`${apiOrigin}/api/v1/workflows/${workflow}/runs`)).json()
      ).items;
    const afterDraft = await readRuns();
    // Two live runs, the builder's and the member's in the published App; the draft's is a test
    // run that names it.
    expect(afterDraft.filter((run) => run.mode === "live")).toHaveLength(2);
    const tests = afterDraft.filter((run) => run.mode === "test");
    expect(tests).toEqual([
      expect.objectContaining({
        startedFrom: expect.objectContaining({ app: appId, workflowRevision: "draft" })
      })
    ]);

    // A tester who may not write the Workflow gets a test run of its published revision.
    const denied = await requestWithOrigin(
      root,
      "post",
      `${apiOrigin}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: builderId,
          action: "workflow.write",
          effect: "deny",
          scopeKind: "asset",
          scopeId: workflowAssetId
        }
      }
    );
    expect(denied.ok(), await denied.text()).toBe(true);
    grants.push(idSchema.parse(await denied.json()).id);
    await page.reload();
    const again = appIn(page, "app-edit");
    await again.getByRole("button", { name: "Log visit" }).click();
    await expect(again.getByTestId("run-status")).toHaveText("done");
    await expect(strip).toContainText("Test run · published Workflow");
    await shoot(page, "app-workflow-action-draft-published-workflow");
    const afterDeny = await readRuns();
    expect(afterDeny.filter((run) => run.mode === "live")).toHaveLength(2);
    expect(
      afterDeny.filter((run) => run.startedFrom?.workflowRevision === "published")
    ).toHaveLength(1);

    // The strip leads to the run, which the Workflows pages mark as the App draft's.
    const latest = afterDeny.find((run) => run.startedFrom?.workflowRevision === "published");
    await strip.getByRole("link", { name: "View run" }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${workflow}/runs/${latest?.id}$`, "u"));
    await expect(page.locator("[data-test-run]").first()).toHaveText(
      `Test · from App draft “${appId}”`
    );
    await shoot(page, "app-workflow-action-test-run-page");
  } finally {
    for (const grantId of grants) {
      await requestWithOrigin(
        root,
        "delete",
        `${apiOrigin}/api/v1/instance/access/grants/${grantId}`
      );
    }
    await memberContext.close();
    await rootContext.close();
  }
});
