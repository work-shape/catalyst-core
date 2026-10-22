import { randomUUID } from "node:crypto";
import { type Browser, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import type { WorkflowStep } from "@work-shape/catalyst-core";
import { sendToolCall } from "./page-surface-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { shootLocales, shootThemes } from "./surface-shots";
import { expect, test, type PageErrorWatch } from "./test";

// The page of a Workflow for the person who builds it: the page head's "Chat" opens a
// conversation about that Workflow, and a bar says when the draft is not what is published,
// with the publish and the discard. A member who only reads the Workflow is offered neither.
// The Workflow is one of this spec's own. Fails without the page half of "the agent edits a
// Workflow": the page offered no conversation and named no draft.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/**
 * The member who reads the Workflow, from `tests/fixtures/e2e-users/workflow-rights.yaml`. The
 * Workflow rights spec gives this member rights too; both hold `accessState`, so one runs after
 * the other.
 */
const member = {
  email: "e2e-workflow-rights@example.test",
  password: "e2e-workflow-rights-password"
};
const WIDE = { width: 1440, height: 900 };
const NAME = "Draft walk";
const chatAction = (page: Page) => page.getByTestId("dock-page-action");

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
    await expect(bar).toContainText("Draft · not published");
    await expect(bar).not.toContainText("Draft differs from published");
    await expect(bar.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
    await expect(chatAction(page)).toBeVisible();
    await shootLocales(page, "nav-2-workflow-draft-page", async () => {
      await expect(bar).toHaveAttribute("data-workflow-draft", "unpublished");
    });

    // The publish names the revision the page read, after one question.
    await bar.getByRole("button", { name: "Publish", exact: true }).click();
    const publish = page.getByRole("dialog", { name: `Publish “${NAME}”?` });
    await expect(publish).toContainText("Version 1 becomes the one that runs");
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

    // The page head's "Chat" makes a conversation about this Workflow and opens it in the dock
    // of the Workflow's page.
    await chatAction(page).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === workflowPath && url.searchParams.has("chat")
    );
    const conversationId = new URL(page.url()).searchParams.get("chat") ?? "";
    const thread = threadSchema.parse(
      await (
        await page.request.get(`${apiBaseUrl}/api/v1/conversations/${conversationId}/thread`)
      ).json()
    );
    expect(thread.conversation.subject).toEqual({ kind: "workflow", name: id });
    expect(thread.conversation.collaborationWorkspaceId).toBe(workspaceId);
    // The dock's head says what the conversation is about before its first message.
    const dockHead = page.getByTestId("dock-head");
    await expect(dockHead).toHaveAttribute("data-subject-kind", "workflow");
    await expect(dockHead).toContainText(`Working on: ${NAME}`);
    // The Workflow is its page: nothing opens beside the dock.
    await expect(workflowPage.getByTestId("workflow-canvas")).toBeVisible();
    await expect(page.locator("aside[data-surface-kind]")).toHaveCount(0);

    // The agent saves a draft: the page is drawn again with the bar of the draft, and the
    // call reads as what it did.
    await sendToolCall(page, "platform.assets.put", {
      config: draftConfig(id, { runAs, description: "The second draft." }),
      expectedRevision: await assetRevision(page, assetUrlOf(id))
    });
    await expect(bar).toHaveAttribute("data-workflow-draft", "ahead");
    await expect(await lastWorkLine(page)).toHaveText(/^Saved version \d+$/u);
    await shootThemes(page, "workflow-from-page", async () => {
      await expect(bar).toHaveAttribute("data-workflow-draft", "ahead");
      await expect(workflowPage.getByText("What the run returns.")).toBeVisible();
    });

    // A view the agent shows opens over the page beside the dock, not over the conversation;
    // closing it shows the page as it was (navigation check 31).
    await sendToolCall(page, "show_view", {
      html: "<p>Surface body</p>",
      mode: "side_panel",
      title: "Surface view"
    });
    const slot = page.locator("aside[data-surface-kind]");
    await expect(slot).toHaveAttribute("data-surface-kind", "tool_display");
    await expect(slot).toHaveAttribute("data-surface-mode", "covering");
    // It slides in over the page: once it stands, it takes the page area exactly.
    const pageArea = await page.locator("[data-dock-page]").boundingBox();
    await expect.poll(() => slot.boundingBox()).toEqual(pageArea);
    await expect(page.getByPlaceholder("Message")).toBeInViewport();
    await slot.getByRole("button", { name: "Show page", exact: true }).click();
    await expect(slot).toBeHidden();
    await expect(bar).toHaveAttribute("data-workflow-draft", "ahead");
    await expect(workflowPage.getByTestId("workflow-canvas")).toBeVisible();

    // Back where "Edit with the agent" was pressed, the bar says that the draft differs.
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === workflowPath && url.search === "");
    await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
    await expect(bar).toHaveAttribute("data-workflow-draft", "ahead");
    await expect(bar).toContainText("Draft differs from published");
    await expect(bar.getByRole("button", { name: "Publish", exact: true })).toBeVisible();

    // The member reads the published Workflow while the draft is ahead: neither is offered.
    await memberPage.goto(workflowPath);
    const memberWorkflow = memberPage.getByTestId("workflow-page");
    await expect(memberWorkflow.getByRole("heading", { level: 1 })).toHaveText(NAME);
    await expect(memberWorkflow.getByTestId("workflow-canvas")).toBeVisible();
    await expect(memberWorkflow.locator("[data-workflow-draft]")).toHaveCount(0);
    // The member is shown what is published, not the draft.
    await expect(memberWorkflow).toContainText("The first draft.");

    // The discard puts the draft back on the published revision, after one question.
    await bar.getByRole("button", { name: "Discard", exact: true }).click();
    const discard = page.getByRole("dialog", { name: `Discard the draft of “${NAME}”?` });
    await expect(discard).toContainText("The draft goes back to the published version 1");
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
    await expect(chatAction(page)).toHaveText(/^Chat/u);
    await expect(bar).toContainText("Entwurf weicht von der veröffentlichten Version ab");
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));

    // In a plain conversation of the builder's own workspace, a read of an asset moves
    // nothing. The agent's open of the Workflow, which belongs to the whole instance, waits
    // for the person: nothing moves and the conversation is about nothing yet, the line says
    // it opened the Workflow and the dock offers to go to it (Platform Access check 46).
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
    const chatUrl = page.url();
    await sendToolCall(page, "platform.assets.open", { kind: "workflow", name: id });
    const openedLine = page.getByTestId("asset-opened-line").last();
    await expect(openedLine).toHaveText(`Opened ${NAME}`);
    const chip = page.getByTestId("asset-opened-chip");
    await expect(chip).toContainText(`Opened ${NAME}`);
    await expect(chip).toHaveAttribute("data-awaits-person", "");
    await expect(subject).toHaveCount(0);
    expect(page.url()).toBe(chatUrl);
    const waitingId = new URL(chatUrl).pathname.split("/").at(-1) ?? "";
    // The press of "Go to it" is the person's confirmation: the conversation is about the
    // Workflow, and its page opens with the conversation in the dock.
    await chip.getByRole("button", { name: "Go to it", exact: true }).click();
    const personalWorkflow = `/w/${personalId}/workflows/${id}`;
    await expect(page).toHaveURL(
      (url) => url.pathname === personalWorkflow && url.searchParams.get("chat") === waitingId
    );
    await expect(dockHead).toHaveAttribute("data-subject-kind", "workflow");
    await expect(chip).toHaveCount(0);
    const confirmed = threadSchema.parse(
      await (
        await page.request.get(`${apiBaseUrl}/api/v1/conversations/${waitingId}/thread`)
      ).json()
    );
    expect(confirmed.conversation.subject).toEqual({ kind: "workflow", name: id });

    // Started from the Workflow's page, the conversation is about it: the agent's open leaves
    // the line that names it, and the person stays on the page.
    await page.goto(personalWorkflow);
    await chatAction(page).click();
    // Chat may bring back the conversation about it from before; "New chat" starts another
    // one about the same Workflow, with nothing said in it yet.
    await expect(page).toHaveURL(
      (url) => url.pathname === personalWorkflow && url.searchParams.has("chat")
    );
    const chatBefore = new URL(page.url()).searchParams.get("chat");
    await dockHead.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === personalWorkflow &&
        url.searchParams.has("chat") &&
        url.searchParams.get("chat") !== chatBefore
    );
    await expect(page.getByText(/^Tool work completed:/u)).toHaveCount(0);
    await sendToolCall(page, "platform.assets.open", { kind: "workflow", name: id });
    await expect(page.getByTestId("asset-opened-line").last()).toHaveText(`Opened ${NAME}`);
    await expect(dockHead).toHaveAttribute("data-subject-kind", "workflow");
    await expect(dockHead).toContainText(NAME);
    expect(new URL(page.url()).pathname).toBe(personalWorkflow);
    await expect(page.getByTestId("asset-opened-chip")).toHaveCount(0);
    await shootThemes(page, "workflow-from-chat", async () => {
      await expect(workflowPage.getByText("What the run returns.")).toBeVisible();
    });

    // A conversation about an agent, as its page starts one: the agent's open from the chat
    // route takes the person to the agent's editor, with the conversation in the dock.
    const aboutAgent = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
      data: {
        collaborationWorkspaceId: personalId,
        subject: { kind: "agent", name: "research_assistant" }
      }
    });
    expect(aboutAgent.ok(), await aboutAgent.text()).toBe(true);
    const agentConversation = idSchema.parse(await aboutAgent.json()).id;
    await page.goto(`/w/${personalId}/c/${agentConversation}`);
    await sendToolCall(page, "platform.assets.open", {
      kind: "agent",
      name: "research_assistant"
    });
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/build/agents/research_assistant" &&
        url.searchParams.get("chat") === agentConversation
    );
    await expect(dockHead).toHaveAttribute("data-subject-kind", "agent");
    const editorReady = async () => {
      await expect(page.getByTestId("asset-opened-line").last()).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(dockHead).toContainText("Research Assistant");
    };
    await editorReady();
    await shootThemes(page, "agent-from-chat", editorReady);
    await shootLocales(page, "nav-2-agent-editor-opened", editorReady);
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

// A failed run's "Fix with the agent" (UXA-6b): the run fails at a step whose operation the
// instance does not have; the runs list says why on the failed row, and the run's main button
// opens the conversation about the Workflow beside the Workflow's page, with the failed step
// and its reason in the composer. Fails without the button or without the prompt reaching the
// dock's composer through the workspace.
test("a failed run is fixed with the agent beside the Workflow's page", async ({ page }) => {
  test.setTimeout(120_000);
  const id = `fix-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  const step = "Load the clients";
  const reason = "What this step uses no longer exists on this instance.";
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  page.setDefaultTimeout(30_000);

  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const { manifest } = draftConfig(id, { runAs, description: "Fails at its second step." });
  // A start does not refuse an operation the instance does not have: the run fails there.
  const saved = await requestWithOrigin(page, "put", assetUrlOf(id), {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          ...manifest,
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "clients",
              name: step,
              type: "operation",
              operation: `connection.${id}.list`,
              input: {}
            },
            { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
          ] satisfies WorkflowStep[]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${assetUrlOf(id)}/publish`, {
    data: { revision: await assetRevision(page, assetUrlOf(id)) }
  });
  expect(published.ok(), await published.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Fix walk ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const started = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/workflows/${id}/runs`,
    { data: { input: {} } }
  );
  expect(started.ok(), await started.text()).toBe(true);
  const runId = idSchema.parse(await started.json()).id;
  await expect
    .poll(
      async () =>
        z
          .looseObject({ status: z.string() })
          .parse(
            await (await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`)).json()
          ).status,
      { timeout: 60_000 }
    )
    .toBe("failed");
  const workflowPath = `/w/${workspaceId}/workflows/${id}`;

  // The failed row says why, in the sentence of the run's page.
  await page.goto(`${workflowPath}/runs`);
  await expect(page.locator("[data-run-reason]")).toHaveText(reason);

  // The run's main button opens the conversation about the Workflow on the Workflow's page.
  await page.goto(`${workflowPath}/runs/${runId}`);
  const runPage = page.getByTestId("workflow-run-page");
  await runPage.getByRole("button", { name: "Fix with the agent", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === workflowPath && url.searchParams.has("chat")
  );
  const conversationId = new URL(page.url()).searchParams.get("chat") ?? "";
  const thread = threadSchema.parse(
    await (
      await page.request.get(`${apiBaseUrl}/api/v1/conversations/${conversationId}/thread`)
    ).json()
  );
  expect(thread.conversation.subject).toEqual({ kind: "workflow", name: id });
  await expect(page.getByTestId("dock-head")).toHaveAttribute("data-subject-kind", "workflow");
  await expect(page.getByTestId("workflow-page").getByTestId("workflow-canvas")).toBeVisible();
  // The composer holds the failed step and its reason, unsent.
  const composer = page.getByPlaceholder("Message");
  await expect.poll(() => composer.inputValue()).toContain(`at the step “${step}”. ${reason}`);
  await expect(page.locator('[data-role="user"]')).toHaveCount(0);
});
