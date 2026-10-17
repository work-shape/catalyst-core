import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { sendToolCall } from "./page-surface-fixtures";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { shootEverywhere } from "./surface-shots";
import { expect, test } from "./test";

// TRY-1a2, PA 45 (browser half): the agent in the dock saves a change of an existing agent as a
// proposal. The agent's page marks the fields the proposal changes with the proposed value
// under each; Apply makes it the live agent and the marks go; Discard drops it and the agent
// stays; Apply on a proposal whose base was saved over says the agent prepares a new one and
// applies nothing. Fails where the page shows no marks, where Apply leaves them, or where a
// stale proposal is applied.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** May read the one agent of the spec and not change it, from `tests/fixtures/e2e-app.yaml`. */
const reader = {
  email: "e2e-agent-proposal-reader@example.test",
  password: "e2e-agent-proposal-reader-password"
};
const shotsDir = process.env.E2E_SHOTS_DIR;
const WIDE = { width: 1280, height: 800 };

const idSchema = z.object({ id: z.string() });
const proposalSchema = z.object({ proposal: z.object({ revision: z.number() }).nullable() });
const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

async function signIn(page: Page, user = superadmin): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
}

/** The agent's definition with these instructions and this description. */
function agentConfig(name: string, instructions: string, description: string) {
  return {
    name,
    displayName: "Contract check",
    description,
    modelBindingId: "primary",
    instructions
  };
}

/** Saves the agent as the live revision; only a new agent takes its availability here. */
async function putAgent(page: Page, name: string, instructions: string): Promise<void> {
  const exists = (await page.request.get(agentPath(name))).ok();
  const stored = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath(name)),
      ...(exists ? {} : { availableIn: "all" }),
      config: agentConfig(name, instructions, "Checks contracts for missing signatures.")
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

async function deleteAgent(page: Page, name: string): Promise<void> {
  const found = await page.request.get(agentPath(name));
  if (found.ok()) {
    await requestWithOrigin(page, "post", `${agentPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(page, agentPath(name)) }
    });
  }
}

test("the agent page marks a proposal, applies it, discards one and refuses a stale one", async ({
  page,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const tag = randomUUID().slice(0, 8);
  const name = `e2e_try_1a2_${tag}`;
  await putAgent(page, name, "Check every contract for a signature.");
  const revision = () => assetRevision(page, agentPath(name));
  try {
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Proposals ${tag}`, defaultConversationVisibility: "private" }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const conversation = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/conversations`,
      {
        data: {
          locale: "en",
          collaborationWorkspaceId: workspaceId,
          subject: { kind: "agent", name }
        }
      }
    );
    expect(conversation.ok(), await conversation.text()).toBe(true);
    const conversationId = idSchema.parse(await conversation.json()).id;
    const proposalUrl = `${apiBaseUrl}/api/v1/agents/${name}/proposals/${conversationId}`;
    const pending = async () =>
      proposalSchema.parse(await (await page.request.get(proposalUrl)).json()).proposal;

    await page.goto(`/build/agents/${name}?chat=${conversationId}`);
    const instructions = page.locator("section#instructions");
    await expect(instructions.getByRole("textbox")).toHaveValue(
      "Check every contract for a signature."
    );
    await expect(page.locator("[data-agent-proposal]")).toHaveCount(0);

    // The agent proposes new instructions and a new description: the live agent stays.
    const live = await revision();
    await sendToolCall(page, "platform.assets.put", {
      config: agentConfig(
        name,
        "Check every contract for a signature and name the clause.",
        "Checks contracts for signatures and clauses."
      ),
      expectedRevision: live
    });
    const notice = page.locator('[data-agent-proposal="pending"]');
    await expect(notice).toContainText("The agent proposes changes to 2 fields");
    await expect(page.locator("[data-proposed-field]")).toHaveCount(2);
    await expect(page.locator('[data-proposed-field="instructions"]')).toContainText(
      "Check every contract for a signature and name the clause."
    );
    await expect(instructions.locator("[data-proposed-section]")).toBeVisible();
    await expect(page.locator("section#overview [data-proposed-section]")).toBeVisible();
    await expect(instructions.getByRole("textbox")).toHaveValue(
      "Check every contract for a signature."
    );
    expect(await revision()).toBe(live);

    await shootEverywhere(page, "try-1a2-proposal", async () => {
      await expect(page.locator("[data-proposed-field]")).toHaveCount(2);
      // At phone width the dock lies over the page: the page is brought forward.
      if ((page.viewportSize()?.width ?? WIDE.width) < 760) {
        await page
          .getByTestId("dock-head")
          .getByRole("button", { name: /^(?:Show page|Seite anzeigen)$/u })
          .click();
      }
      await expect(page.locator("[data-agent-proposal]")).toBeInViewport();
    });

    // Apply makes the proposal the live agent, and the marks go.
    await notice.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator("[data-agent-proposal]")).toHaveCount(0);
    await expect(page.locator("[data-proposed-field]")).toHaveCount(0);
    await expect(instructions.getByRole("textbox")).toHaveValue(
      "Check every contract for a signature and name the clause."
    );
    expect(await revision()).toBe(live + 1);
    expect(await pending()).toBeNull();

    // Discard drops the next proposal, and the agent stays as it is.
    await sendToolCall(page, "platform.assets.put", {
      config: agentConfig(name, "Only read the contract.", "Checks contracts for signatures."),
      expectedRevision: live + 1
    });
    await expect(page.locator('[data-proposed-field="instructions"]')).toContainText(
      "Only read the contract."
    );
    await page
      .locator('[data-agent-proposal="pending"]')
      .getByRole("button", { name: "Discard proposal", exact: true })
      .click();
    await expect(page.locator("[data-agent-proposal]")).toHaveCount(0);
    expect(await pending()).toBeNull();
    expect(await revision()).toBe(live + 1);

    // A proposal whose base was saved over is not applied: the page says to ask the agent in
    // the chat again.
    await sendToolCall(page, "platform.assets.put", {
      config: agentConfig(name, "Read the contract twice.", "Checks contracts for signatures."),
      expectedRevision: live + 1
    });
    await expect(page.locator('[data-proposed-field="instructions"]')).toContainText(
      "Read the contract twice."
    );
    await putAgent(page, name, "Somebody else's instructions.");
    await page
      .locator('[data-agent-proposal="pending"]')
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    await expect(page.locator('[data-agent-proposal="stale"]')).toContainText(
      "This proposal can no longer be applied. Ask the agent in the chat to make the change again."
    );
    await expect(page.locator("[data-proposal-apply]")).toHaveCount(0);
    await expect(page.locator("[data-proposed-field]")).toHaveCount(0);
    expect(await revision()).toBe(live + 2);

    // The agent's next save is a new proposal on the live agent: its marks and Apply are back.
    await sendToolCall(page, "platform.assets.put", {
      config: agentConfig(name, "Read the contract three times.", "Checks contracts."),
      expectedRevision: live + 2
    });
    await expect(page.locator('[data-agent-proposal="pending"]')).toBeVisible();
    await expect(page.locator('[data-proposed-field="instructions"]')).toContainText(
      "Read the contract three times."
    );
    await expect(page.locator("[data-proposal-apply]")).toBeEnabled();
  } finally {
    await deleteAgent(page, name);
  }
});

/** A conversation of the signed-in person in the workspace, about the agent where it is named. */
async function conversationIn(page: Page, workspaceId: string, agent?: string): Promise<string> {
  const conversation = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations`, {
    data: {
      locale: "en",
      collaborationWorkspaceId: workspaceId,
      ...(agent === undefined ? {} : { subject: { kind: "agent", name: agent } })
    }
  });
  expect(conversation.ok(), await conversation.text()).toBe(true);
  return idSchema.parse(await conversation.json()).id;
}

// The pictures of the states for review: 1280 light English and 390 dark German.
const VARIANTS = [
  { width: 1280, height: 800, theme: "light", locale: "en" },
  { width: 390, height: 844, theme: "dark", locale: "de" }
] as const;

/**
 * Loads the agent page in each variant, brings it forward over the dock on a phone, reaches a
 * state with `reach` and takes its picture where `E2E_SHOTS_DIR` names a folder. The page is
 * left light, in English, at 1280.
 */
async function shootStates(
  page: Page,
  name: string,
  reach: (variant: (typeof VARIANTS)[number]) => Promise<void>
): Promise<void> {
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  for (const variant of VARIANTS) {
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.evaluate(
      ([theme, locale]) => {
        window.localStorage.setItem("vivd-catalyst:theme", theme);
        window.localStorage.setItem("vivd-catalyst:locale", locale);
      },
      [variant.theme, variant.locale] as const
    );
    await page.reload();
    await expect(page.locator("[data-agent-proposal]")).toHaveCount(1);
    if (variant.width < 760) {
      await page
        .getByTestId("dock-head")
        .getByRole("button", { name: /^(?:Show page|Seite anzeigen)$/u })
        .click();
    }
    await reach(variant);
    if (shotsDir) {
      await page.screenshot({
        path: join(shotsDir, `${name}-${variant.width}-${variant.theme}-${variant.locale}.png`),
        animations: "disabled"
      });
    }
  }
  await page.evaluate(() => {
    window.localStorage.setItem("vivd-catalyst:theme", "light");
    window.localStorage.setItem("vivd-catalyst:locale", "en");
  });
  await page.setViewportSize(WIDE);
}

/** The agent as proposed with a change in each kind of field, as the instance would answer it. */
function richProposal(name: string, conversationId: string, revision: number, stale = false) {
  return {
    proposal: {
      agent: name,
      conversationId,
      revision,
      baseRevision: 1,
      liveRevision: stale ? 2 : 1,
      stale,
      updatedAt: new Date().toISOString(),
      config: {
        ...agentConfig(
          name,
          [
            "Check every contract for a signature.",
            "Name the clause that misses one.",
            "Say which party has to sign.",
            "Never change the contract itself."
          ].join("\n"),
          revision === 1
            ? "Checks contracts for signatures and clauses."
            : "Checks contracts for signatures, clauses and dates."
        ),
        reasoningEffort: "high",
        fastMode: true,
        skillNames: ["contract-review"],
        toolNames: ["web_search"],
        knowledgeBases: ["contracts"],
        initialPrompts: [
          {
            title: { en: "Check a contract", de: "Vertrag prüfen" },
            prompt: { en: "Check this contract.", de: "Prüfe diesen Vertrag." }
          }
        ]
      }
    }
  };
}

test("the proposal's states and each kind of proposed value, for a writer and a reader", async ({
  page,
  browser,
  pageErrors,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  // A page with unsaved changes asks before it loads again; each picture loads it again.
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => undefined);
  });
  const tag = randomUUID().slice(0, 8);
  const name = `e2e_try_1a2_states_${tag}`;
  await putAgent(page, name, "Check every contract for a signature.");
  const grants: string[] = [];
  try {
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Proposal states ${tag}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const conversationId = await conversationIn(page, workspaceId, name);
    const proposalUrl = `**/api/v1/agents/${name}/proposals/${conversationId}`;
    let answer = richProposal(name, conversationId, 1);
    await page.route(proposalUrl, (route) => route.fulfill({ json: answer }));
    await page.goto(`/build/agents/${name}?chat=${conversationId}`);
    await expect(page.locator('[data-agent-proposal="pending"]')).toBeVisible();

    // Each kind of proposed value, scrolled to.
    const kinds = ["instructions", "model", "skillNames", "toolNames", "initialPrompts"];
    if ((await page.locator("section#knowledge").count()) > 0) kinds.push("knowledgeBases");
    for (const kind of kinds) {
      await shootStates(page, `try-1a2-box-${kind}`, async () => {
        const box = page.locator(`[data-proposed-field="${kind}"]`);
        await box.scrollIntoViewIfNeeded();
        await expect(box).toBeInViewport();
      });
    }

    // Unsaved changes of the reader's own: Apply waits and says why, in words.
    await shootStates(page, "try-1a2-unsaved", async ({ locale }) => {
      await page.locator("section#instructions").getByRole("textbox").first().fill("Mine.");
      await expect(page.locator("[data-proposal-apply]")).toBeDisabled();
      await expect(page.locator("[data-agent-proposal]")).toContainText(
        locale === "de"
          ? "Speichere oder verwirf zuerst deine eigenen Änderungen."
          : "Save or discard your own changes first."
      );
      await page
        .locator("[data-agent-proposal]")
        .evaluate((banner) => banner.scrollIntoView({ block: "center" }));
    });

    // The agent wrote a newer proposal than the one read: one banner says so.
    const applyUrl = `${proposalUrl}/apply`;
    await page.route(applyUrl, async (route) => {
      answer = richProposal(name, conversationId, 2);
      await route.fulfill({
        status: 412,
        json: {
          error: {
            code: "REVISION_CONFLICT",
            message: "The proposal changed.",
            correlationId: "corr_e2e_try_1a2",
            details: { reason: "proposal_changed" }
          }
        }
      });
    });
    await shootStates(page, "try-1a2-changed", async () => {
      await page.locator("[data-proposal-apply]").click();
      await expect(page.locator('[data-proposal-answer="changed"]')).toHaveCount(1);
      await expect(page.locator("[data-proposal-answer]")).toHaveCount(1);
      answer = richProposal(name, conversationId, 1);
    });
    await page.unroute(applyUrl);

    // The instance failed: the page says so beside the proposal.
    await page.route(applyUrl, (route) =>
      route.fulfill({
        status: 500,
        json: { error: { code: "INTERNAL_ERROR", message: "Internal error", correlationId: "c" } }
      })
    );
    await shootStates(page, "try-1a2-failed", async () => {
      await page.locator("[data-proposal-apply]").click();
      await expect(page.locator('[data-proposal-answer="failed"]')).toBeVisible();
    });
    await page.unroute(applyUrl);

    // A stale proposal offers Discard alone and says to ask the agent in the chat again.
    answer = richProposal(name, conversationId, 1, true);
    await shootStates(page, "try-1a2-stale", async ({ locale }) => {
      await expect(page.locator('[data-agent-proposal="stale"]')).toContainText(
        locale === "de"
          ? "Bitte den Agenten im Chat, die Änderung noch einmal vorzuschlagen."
          : "Ask the agent in the chat to make the change again."
      );
      await expect(page.locator("[data-proposal-apply]")).toHaveCount(0);
      await expect(page.locator("[data-proposal-discard]")).toBeVisible();
    });

    // A reader who may not change the agent sees the marks and who can apply them.
    const readerContext = await browser.newContext({ viewport: WIDE });
    await pageErrors.watch(readerContext);
    const readerPage = await readerContext.newPage();
    readerPage.setDefaultTimeout(30_000);
    await signIn(readerPage, reader);
    const me = await readerPage.request.get(`${apiBaseUrl}/api/v1/me`);
    expect(me.ok()).toBe(true);
    const readerId = idSchema.parse(await me.json()).id;
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: reader.email } }
    );
    expect(added.ok(), await added.text()).toBe(true);
    const assetId = idSchema.parse(await (await page.request.get(agentPath(name))).json()).id;
    const granted = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: readerId,
          action: "agent.read",
          effect: "allow",
          scopeKind: "asset",
          scopeId: assetId
        }
      }
    );
    expect(granted.ok(), await granted.text()).toBe(true);
    grants.push(idSchema.parse(await granted.json()).id);
    const readerConversation = await conversationIn(readerPage, workspaceId);
    const readerAnswer = richProposal(name, readerConversation, 1);
    await readerPage.route(`**/api/v1/agents/${name}/proposals/${readerConversation}`, (route) =>
      route.fulfill({ json: readerAnswer })
    );
    await readerPage.goto(`/build/agents/${name}?chat=${readerConversation}`);
    await shootStates(readerPage, "try-1a2-reader", async ({ locale }) => {
      await expect(readerPage.locator('[data-agent-proposal="pending"]')).toContainText(
        locale === "de"
          ? "Übernehmen kann sie, wer diesen Agenten ändern darf."
          : "Someone who may change this agent can apply them."
      );
      await expect(readerPage.locator("[data-proposal-apply]")).toHaveCount(0);
      await expect(readerPage.locator("[data-proposed-field]").first()).toBeVisible();
    });
    await readerContext.close();
  } finally {
    for (const grantId of grants) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grantId}`
      );
    }
    await deleteAgent(page, name);
  }
});
