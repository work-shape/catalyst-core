import { randomUUID } from "node:crypto";
import { type Browser, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { sendToolCall } from "./page-surface-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { shootThemes } from "./surface-shots";
import { expect, test, type PageErrorWatch } from "./test";

// The page of a Workflow for the person who builds it: "Edit with the agent" opens a
// conversation about that Workflow, and a bar says when the draft is not what is published,
// with the publish and the discard. A member who only reads the Workflow is offered neither.
// The Workflow is one of this spec's own. Fails without the page half of "the agent edits a
// Workflow": the page offered no conversation and named no draft.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/**
 * The member who reads the Workflow, from `tests/fixtures/e2e-app.yaml`. The Workflow rights
 * spec gives this member rights too; both hold `accessState`, so one runs after the other.
 */
const member = {
  email: "e2e-workflow-rights@example.test",
  password: "e2e-workflow-rights-password"
};
const WIDE = { width: 1440, height: 900 };
const NAME = "Draft walk";
const EDIT = "Edit with the agent";

const idSchema = z.object({ id: z.string() });
const workspaceListSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.string() }))
});
const threadSchema = z.object({
  conversation: z.object({
    collaborationWorkspaceId: z.string(),
    subject: z.object({ kind: z.string(), name: z.string() }).optional()
  })
});

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A page of its own session, watched for page errors like the test's own. */
async function sessionOf(
  browser: Browser,
  watch: PageErrorWatch["watch"],
  user: { email: string; password: string }
): Promise<Page> {
  const context = await browser.newContext({ viewport: WIDE });
  await watch(context);
  const page = await context.newPage();
  await signIn(page, user);
  return page;
}

/**
 * The line the last finished run's calls read as. A run that ended folds its calls into its
 * Work history, at once or a moment later: the history is waited for folded, then opened.
 */
async function lastWorkLine(page: Page): Promise<Locator> {
  const message = page.locator('[data-role="assistant"]').last();
  const history = message.getByRole("button", { name: /^Work history/u });
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await history.click();
  await expect(history).toHaveAttribute("aria-expanded", "true");
  return message.getByTestId("tool-call-fold-sentence");
}

const assetUrlOf = (id: string) => `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

/** A definition of the Workflow with this description. */
function draftConfig(id: string, input: { runAs: string; description: string }) {
  return {
    name: id,
    manifest: {
      id,
      name: NAME,
      description: input.description,
      runAs: input.runAs,
      inputs: { type: "object", additionalProperties: false },
      outputs: {
        type: "object",
        properties: { done: { type: "integer" } },
        required: ["done"]
      },
      steps: [
        { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
      ]
    }
  };
}

/** Saves a draft of the Workflow: a new one, or the next revision of the one that is stored. */
async function saveDraft(
  root: Page,
  id: string,
  input: { runAs: string; description: string; expectedRevision: number | null }
): Promise<void> {
  const saved = await requestWithOrigin(root, "put", assetUrlOf(id), {
    data: { expectedRevision: input.expectedRevision, config: draftConfig(id, input) }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

test("the builder of a Workflow edits it with the agent and publishes or discards its draft", async ({
  page,
  browser,
  pageErrors,
  accessState: _accessState
}) => {
  test.setTimeout(180_000);
  const id = `draft-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  page.setDefaultTimeout(30_000);

  // The Workflow's account, a first draft that is published nowhere, and a workspace to
  // stand in: a Workflow belongs to none, and its page has the address of the open one.
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  await saveDraft(page, id, { runAs, description: "The first draft.", expectedRevision: null });
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Draft walk ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  // A seeded user is known to the instance once the user has signed in.
  const memberPage = await sessionOf(browser, pageErrors.watch, member);
  const me = await memberPage.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(me.ok()).toBe(true);
  const memberId = idSchema.parse(await me.json()).id;
  const added = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);
  const workflowPath = `/w/${workspaceId}/workflows/${id}`;

  try {
    // A draft that was never published: the bar says that, and not that it differs.
    await page.goto(workflowPath);
    const workflowPage = page.getByTestId("workflow-page");
    await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
    const bar = workflowPage.locator("[data-workflow-draft]");
    await expect(bar).toHaveAttribute("data-workflow-draft", "unpublished");
    await expect(bar).toContainText("Draft, not published yet");
    await expect(bar).not.toContainText("Draft differs from published");
    await expect(bar.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
    await expect(workflowPage.getByRole("button", { name: EDIT, exact: true })).toBeVisible();

    // The publish names the revision the page read, after one question.
    await bar.getByRole("button", { name: "Publish", exact: true }).click();
    const publish = page.getByRole("dialog", { name: `Publish “${NAME}”?` });
    await expect(publish).toContainText("Revision 1 becomes the version that runs");
    await publish.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(publish).toBeHidden();
    // The draft is the published revision now: no bar, and the Workflow can be started.
    await expect(bar).toHaveCount(0);
    await expect(
      workflowPage.getByRole("button", { name: "Start now", exact: true })
    ).toBeVisible();

    // The member is given reading on this one Workflow: no conversation, and no bar.
    const asset = idSchema.parse(await (await page.request.get(assetUrlOf(id))).json());
    const granted = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: memberId,
          action: "workflow.read",
          effect: "allow",
          scopeKind: "asset",
          scopeId: asset.id
        }
      }
    );
    expect(granted.ok(), await granted.text()).toBe(true);

    // "Edit with the agent" makes a conversation about this Workflow and opens it.
    await workflowPage.getByRole("button", { name: EDIT, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/c/[^/]+$`, "u"));
    const conversationId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const thread = threadSchema.parse(
      await (
        await page.request.get(`${apiBaseUrl}/api/v1/conversations/${conversationId}/thread`)
      ).json()
    );
    expect(thread.conversation.subject).toEqual({ kind: "workflow", name: id });
    expect(thread.conversation.collaborationWorkspaceId).toBe(workspaceId);
    // The conversation says what it is about before its first message, and leads back.
    const subjectLine = page.getByTestId("conversation-subject");
    await expect(subjectLine).toContainText(NAME);
    await expect(subjectLine.getByRole("link", { name: NAME, exact: true })).toHaveAttribute(
      "href",
      workflowPath
    );

    // The Workflow opens on its canvas beside the conversation, as it is published.
    const surface = page.locator('[data-surface-kind="workflow_canvas"]');
    await expect(surface).toBeVisible();
    await expect(surface.getByTestId("workflow-canvas")).toBeVisible();
    await expect(surface.locator("[data-workflow-draft]")).toHaveCount(0);

    // "Open page" in the head of the panel opens the Workflow's page in a new tab, with no
    // conversation in its address; the conversation stays where it is.
    const conversationUrl = page.url();
    const [opened] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByRole("button", { name: "Open the workflow's page", exact: true }).click()
    ]);
    await opened.waitForURL((url) => url.pathname === workflowPath);
    expect(new URL(opened.url()).searchParams.has("chat")).toBe(false);
    await opened.close();
    expect(page.url()).toBe(conversationUrl);

    // The agent saves a draft: the canvas beside the chat is drawn again with the bar of the
    // draft, and the call reads as what it did.
    await sendToolCall(page, "platform.assets.put", {
      config: draftConfig(id, { runAs, description: "The second draft." }),
      expectedRevision: await assetRevision(page, assetUrlOf(id))
    });
    await expect(surface.locator("[data-workflow-draft]")).toHaveAttribute(
      "data-workflow-draft",
      "ahead"
    );
    await expect(await lastWorkLine(page)).toHaveText(/^Saved revision \d+$/u);
    await shootThemes(page, "workflow-from-page", async () => {
      await expect(surface.locator("[data-workflow-draft]")).toHaveAttribute(
        "data-workflow-draft",
        "ahead"
      );
      await expect(surface.getByText("What the run returns.")).toBeVisible();
    });

    // Back on the page of the Workflow the bar says that the draft differs.
    await page.goBack();
    await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
    await expect(bar).toHaveAttribute("data-workflow-draft", "ahead");
    await expect(bar).toContainText("Draft differs from published");
    await expect(bar.getByRole("button", { name: "Publish", exact: true })).toBeVisible();

    // The member reads the published Workflow while the draft is ahead: neither is offered.
    await memberPage.goto(workflowPath);
    const memberWorkflow = memberPage.getByTestId("workflow-page");
    await expect(memberWorkflow.getByRole("heading", { level: 1 })).toHaveText(NAME);
    await expect(memberWorkflow.getByTestId("workflow-canvas")).toBeVisible();
    await expect(memberWorkflow.getByRole("button", { name: EDIT, exact: true })).toHaveCount(0);
    await expect(memberWorkflow.locator("[data-workflow-draft]")).toHaveCount(0);
    // The member is shown what is published, not the draft.
    await expect(memberWorkflow).toContainText("The first draft.");

    // The discard puts the draft back on the published revision, after one question.
    await bar.getByRole("button", { name: "Discard", exact: true }).click();
    const discard = page.getByRole("dialog", { name: `Discard the draft of “${NAME}”?` });
    await expect(discard).toContainText("The draft goes back to the published revision 1");
    await discard.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(discard).toBeHidden();
    await expect(bar).toHaveCount(0);
    await expect(workflowPage).toContainText("The first draft.");

    // In German the button and the bar read as the rest of the page does.
    await saveDraft(page, id, {
      runAs,
      description: "The third draft.",
      expectedRevision: await assetRevision(page, assetUrlOf(id))
    });
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();
    await expect(
      workflowPage.getByRole("button", { name: "Mit dem Agenten bearbeiten", exact: true })
    ).toBeVisible();
    await expect(bar).toContainText("Entwurf weicht von der veröffentlichten Version ab");
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));

    // In a plain conversation of the builder's own workspace, a read of an asset moves
    // nothing, and the agent's own open of the Workflow is refused: it belongs to the whole
    // instance, and only the person's step makes it what a conversation is about.
    const workspaces = workspaceListSchema.parse(
      await (await page.request.get(`${apiBaseUrl}/api/v1/workspaces?limit=100`)).json()
    );
    const personal = workspaces.items.find((workspace) => workspace.kind === "personal");
    expect(personal).toBeDefined();
    const personalId = personal?.id ?? "";
    await page.goto(`/w/${personalId}`);
    await sendToolCall(page, "platform.assets.get", { kind: "workflow", name: id });
    const subject = page.getByTestId("conversation-subject");
    await expect(await lastWorkLine(page)).toHaveText("Read the workflow");
    await expect(subject).toHaveCount(0);
    const touched = page.locator('[data-surface-kind="workflow_canvas"]');
    await expect(touched).toHaveCount(0);
    await sendToolCall(page, "platform.assets.open", { kind: "workflow", name: id });
    await expect(await lastWorkLine(page)).toHaveText("The asset could not be opened");
    await expect(subject).toHaveCount(0);
    await expect(touched).toHaveCount(0);

    // Started from the Workflow's page, the conversation is about it: the agent's open shows
    // it beside the chat, with a line that names it.
    await page.goto(`/w/${personalId}/workflows/${id}`);
    await workflowPage.getByRole("button", { name: EDIT, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${personalId}/c/[^/]+$`, "u"));
    await sendToolCall(page, "platform.assets.open", { kind: "workflow", name: id });
    await expect(await lastWorkLine(page)).toHaveText(`Opened ${NAME}`);
    await expect(subject).toHaveAttribute("data-subject-kind", "workflow");
    await expect(subject).toContainText(NAME);
    await expect(touched.getByTestId("workflow-canvas")).toBeVisible();
    await shootThemes(page, "workflow-from-chat", async () => {
      await expect(touched.getByText("What the run returns.")).toBeVisible();
    });

    // A conversation about an agent, as its page starts one, shows the agent's form when the
    // agent opens it.
    const aboutAgent = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
      data: {
        collaborationWorkspaceId: personalId,
        subject: { kind: "agent", name: "research_assistant" }
      }
    });
    expect(aboutAgent.ok(), await aboutAgent.text()).toBe(true);
    await page.goto(`/w/${personalId}/c/${idSchema.parse(await aboutAgent.json()).id}`);
    await sendToolCall(page, "platform.assets.open", {
      kind: "agent",
      name: "research_assistant"
    });
    await expect(subject).toHaveAttribute("data-subject-kind", "agent");
    const studio = page.locator('[data-surface-kind="agent"]').getByTestId("agent-surface");
    await expect(studio).toBeVisible();
    await shootThemes(page, "agent-from-chat", async () => {
      await expect(studio).toBeVisible();
    });
  } finally {
    // Whatever the test left: the member's rows on the Workflow.
    const listed = await page.request.get(
      `${apiBaseUrl}/api/v1/instance/access/grants?holderKind=user&limit=100`
    );
    const rows: { items: { id: string; scopeAsset?: { name?: string } }[] } = listed.ok()
      ? await listed.json()
      : { items: [] };
    for (const grant of rows.items.filter((item) => item.scopeAsset?.name === id)) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grant.id}`
      );
    }
    await memberPage.context().close();
  }
});
