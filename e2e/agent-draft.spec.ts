import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
import { shootEverywhere } from "./surface-shots";
import { expect, test } from "./test";

// AD-4, Navigation check 44 (browser half): the agent page edits the agent's one draft. Save
// draft writes it and leaves the live agent as it is, and saves again on the draft it wrote;
// Build > Agents marks the agent; Publish makes the draft live and Discard drops it. A writer
// without agent.publish sees Publish disabled with the right named; a save over a draft
// somebody else wrote meanwhile is refused, named with its author and offers to load it; a
// reader who may not change the agent sees the live agent and no draft. Fails where the second
// save is refused, where the page shows the live agent after a save, or where Publish is not
// on the page.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** May change agents and not publish them, from `tests/fixtures/e2e-app.yaml`. */
const writer = {
  email: "e2e-agent-draft-writer@example.test",
  password: "e2e-agent-draft-writer-password"
};
/** May read the one agent of the spec and not change it, from `tests/fixtures/e2e-app.yaml`. */
const reader = {
  email: "e2e-agent-draft-reader@example.test",
  password: "e2e-agent-draft-reader-password"
};
const shotsDir = process.env.E2E_SHOTS_DIR;
const WIDE = { width: 1280, height: 800 };

const idSchema = z.object({ id: z.string() });
const draftSchema = z.object({ draft: z.object({ revision: z.number() }).nullable() });
const liveSchema = z.object({ config: z.object({ instructions: z.string() }) });
const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;
const draftPath = (name: string) => `${apiBaseUrl}/api/v1/agents/${name}/draft`;

async function signIn(page: Page, user = superadmin): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
}

function agentConfig(name: string, displayName: string, instructions: string) {
  return {
    name,
    displayName,
    description: "Checks contracts for missing signatures.",
    modelBindingId: "primary",
    instructions
  };
}

/** The agent's draft revision, or null where it has none. */
async function draftRevision(page: Page, name: string): Promise<number | null> {
  const answer = await page.request.get(draftPath(name));
  return draftSchema.parse(await answer.json()).draft?.revision ?? null;
}

/** A new agent saves live; a save of an existing one writes its draft. */
async function putAgent(
  page: Page,
  name: string,
  displayName: string,
  instructions: string
): Promise<void> {
  const exists = (await page.request.get(agentPath(name))).ok();
  const stored = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath(name)),
      ...(exists
        ? { expectedDraftRevision: await draftRevision(page, name) }
        : { availableIn: "all" }),
      config: agentConfig(name, displayName, instructions)
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

async function liveInstructions(page: Page, name: string): Promise<string> {
  return liveSchema.parse(await (await page.request.get(agentPath(name))).json()).config
    .instructions;
}

async function deleteAgent(page: Page, name: string): Promise<void> {
  const found = await page.request.get(agentPath(name));
  if (found.ok()) {
    await requestWithOrigin(page, "post", `${agentPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(page, agentPath(name)) }
    });
  }
}

/** One picture of the page as it stands, where `E2E_SHOTS_DIR` names a folder. */
async function shootOnce(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

const instructionsOf = (page: Page) =>
  page.locator("section#instructions").getByRole("textbox").first();
const saveDraftOf = (page: Page) => page.getByRole("button", { name: "Save draft", exact: true });
const badgeOf = (page: Page) => page.locator("[data-agent-draft-badge]");

/** The agent's row in Build > Agents, found by its search. */
async function studioRow(page: Page, displayName: string) {
  await page.goto("/build/agents");
  await page.getByRole("searchbox", { name: "Search agents" }).fill(displayName);
  // The list answers the search after a pause: the instance's own agents go then.
  await expect(page.getByRole("listitem").filter({ hasText: "Research Assistant" })).toHaveCount(0);
  return page.getByRole("listitem").filter({ hasText: displayName });
}

test("the agent page saves a draft twice, publishes it, and discards the next one", async ({
  page,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const tag = randomUUID().slice(0, 8);
  const name = `e2e_ad_4_${tag}`;
  const displayName = `Contract check ${tag}`;
  await putAgent(page, name, displayName, "Check every contract for a signature.");
  const live = await assetRevision(page, agentPath(name));
  try {
    await page.goto(`/build/agents/${name}`);
    await expect(instructionsOf(page)).toHaveValue("Check every contract for a signature.");
    await expect(badgeOf(page)).toHaveCount(0);

    // Save draft writes the draft; the page shows it and the live agent stays.
    await instructionsOf(page).fill("Check every contract for a signature and name the clause.");
    await saveDraftOf(page).click();
    await expect(badgeOf(page)).toHaveText("Draft revision 1");
    // The banner names the author and the time; the head's badge only the revision.
    await expect(page.locator('[data-agent-draft="pending"]')).toContainText(
      "Draft revision 1, saved by E2E Superadmin on "
    );
    await expect(instructionsOf(page)).toHaveValue(
      "Check every contract for a signature and name the clause."
    );
    await expect(page.locator('[data-published-field="instructions"]')).toContainText(
      "Check every contract for a signature."
    );
    expect(await assetRevision(page, agentPath(name))).toBe(live);
    expect(await liveInstructions(page, name)).toBe("Check every contract for a signature.");

    // A second save writes the draft again, on the revision the first one wrote.
    await instructionsOf(page).fill("Name the clause that misses a signature.");
    await saveDraftOf(page).click();
    await expect(badgeOf(page)).toHaveText("Draft revision 2");
    await expect(page.locator("[data-agent-draft-behind]")).toHaveCount(0);
    expect(await draftRevision(page, name)).toBe(2);
    expect(await liveInstructions(page, name)).toBe("Check every contract for a signature.");

    // At phone width the head gives its badge way to the name; the banner names the draft.
    await shootEverywhere(page, "ad-4-draft", async () => {
      await expect(badgeOf(page)).toBeAttached();
      await expect(page.locator('[data-agent-draft="pending"]')).toBeVisible();
    });

    // Build > Agents marks the agent that has a draft.
    const row = await studioRow(page, displayName);
    await expect(row.locator("[data-build-draft-state]")).toHaveText("Draft");
    await shootOnce(page, "ad-4-list-1280-light-en");

    // Publish makes the draft the live agent, and the badge goes.
    await page.goto(`/build/agents/${name}`);
    await expect(badgeOf(page)).toBeVisible();
    await page.locator("[data-agent-publish]").click();
    const publish = page.getByRole("dialog", { name: `Publish ${displayName}?` });
    await publish.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(badgeOf(page)).toHaveCount(0);
    await expect(page.locator("[data-agent-publish]")).toHaveCount(0);
    await expect(instructionsOf(page)).toHaveValue("Name the clause that misses a signature.");
    expect(await assetRevision(page, agentPath(name))).toBe(live + 1);
    expect(await draftRevision(page, name)).toBeNull();
    expect(await liveInstructions(page, name)).toBe("Name the clause that misses a signature.");

    // Discard, from the "…" menu and behind a dialog, drops the next draft; the agent stays.
    await instructionsOf(page).fill("Only read the contract.");
    await saveDraftOf(page).click();
    await expect(badgeOf(page)).toHaveText(/^Draft revision \d+$/u);
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Discard draft", exact: true }).click();
    const discard = page.getByRole("dialog", { name: `Discard the draft of ${displayName}?` });
    await expect(discard).toContainText("The published version stays as it is.");
    await shootOnce(page, "ad-4-discard-1280-light-en");
    await discard.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(badgeOf(page)).toHaveCount(0);
    await expect(instructionsOf(page)).toHaveValue("Name the clause that misses a signature.");
    expect(await draftRevision(page, name)).toBeNull();
    expect(await assetRevision(page, agentPath(name))).toBe(live + 1);
  } finally {
    await deleteAgent(page, name);
  }
});

test("a writer without agent.publish, a draft written meanwhile, a reader, and a publish grant on the agent", async ({
  page,
  browser,
  pageErrors,
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const tag = randomUUID().slice(0, 8);
  const name = `e2e_ad_4_rights_${tag}`;
  const displayName = `Contract rights ${tag}`;
  await putAgent(page, name, displayName, "Check every contract for a signature.");
  await putAgent(page, name, displayName, "Check every contract twice.");
  const grants: string[] = [];
  const writerContext = await browser.newContext({ viewport: WIDE });
  const readerContext = await browser.newContext({ viewport: WIDE });
  try {
    await pageErrors.watch(writerContext);
    await pageErrors.watch(readerContext);

    // The writer sees the draft and Publish disabled, with the right it needs named.
    const writerPage = await writerContext.newPage();
    writerPage.setDefaultTimeout(30_000);
    await signIn(writerPage, writer);
    await writerPage.goto(`/build/agents/${name}`);
    await expect(badgeOf(writerPage)).toHaveText("Draft revision 1");
    await expect(writerPage.locator('[data-agent-draft="pending"]')).toContainText(
      "saved by E2E Superadmin on "
    );
    await expect(instructionsOf(writerPage)).toHaveValue("Check every contract twice.");
    const publish = writerPage.locator("[data-agent-publish]");
    await expect(publish).toBeDisabled();
    const reasonId = await publish.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    await expect(writerPage.locator(`[id="${reasonId}"]`)).toHaveText(
      "Publishing needs the right “Publish agents”."
    );
    await shootEverywhere(writerPage, "ad-4-writer", async () => {
      await expect(writerPage.locator("[data-agent-publish]")).toBeDisabled();
    });

    // Somebody else saves the draft while the writer edits: the writer's save is refused, the
    // page says who and offers to load the newer draft, and the writer's text stays.
    await instructionsOf(writerPage).fill("Mine.");
    await putAgent(page, name, displayName, "Read the contract three times.");
    await saveDraftOf(writerPage).click();
    const behind = writerPage.locator('[data-agent-draft-behind="2"]');
    await expect(behind).toContainText("E2E Superadmin saved draft revision 2 on");
    await expect(instructionsOf(writerPage)).toHaveValue("Mine.");
    await expect(saveDraftOf(writerPage)).toBeDisabled();
    await behind.scrollIntoViewIfNeeded();
    await shootOnce(writerPage, "ad-4-behind-1280-light-en");
    await behind.getByRole("button", { name: "Load the newer draft", exact: true }).click();
    await expect(badgeOf(writerPage)).toHaveText("Draft revision 2");
    await expect(instructionsOf(writerPage)).toHaveValue("Read the contract three times.");
    // The writer goes on from the newer draft and saves on it.
    await instructionsOf(writerPage).fill("Read the contract three times, slowly.");
    await saveDraftOf(writerPage).click();
    await expect(badgeOf(writerPage)).toHaveText("Draft revision 3");
    await expect(writerPage.locator('[data-agent-draft="pending"]')).toContainText(
      "saved by E2E Zz Agent Draft Writer on "
    );
    expect(await draftRevision(page, name)).toBe(3);

    // A reader of the agent sees the live agent: no draft, no badge, no Publish.
    const readerPage = await readerContext.newPage();
    readerPage.setDefaultTimeout(30_000);
    await signIn(readerPage, reader);
    const me = await readerPage.request.get(`${apiBaseUrl}/api/v1/me`);
    expect(me.ok()).toBe(true);
    const readerId = idSchema.parse(await me.json()).id;
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
    await readerPage.goto(`/build/agents/${name}`);
    await expect(instructionsOf(readerPage)).toHaveValue("Check every contract for a signature.");
    await expect(badgeOf(readerPage)).toHaveCount(0);
    await expect(readerPage.locator("[data-agent-publish]")).toHaveCount(0);
    await expect(readerPage.locator("[data-agent-draft]")).toHaveCount(0);
    const row = await studioRow(readerPage, displayName);
    await expect(row).toHaveCount(1);
    await expect(row.locator("[data-build-draft-state]")).toHaveCount(0);

    // A grant of agent.publish on this agent alone enables Publish for the writer, as the
    // instance decides it, and the writer publishes the draft.
    const writerMe = await writerPage.request.get(`${apiBaseUrl}/api/v1/me`);
    expect(writerMe.ok()).toBe(true);
    const publishGranted = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: idSchema.parse(await writerMe.json()).id,
          action: "agent.publish",
          effect: "allow",
          scopeKind: "asset",
          scopeId: assetId
        }
      }
    );
    expect(publishGranted.ok(), await publishGranted.text()).toBe(true);
    grants.push(idSchema.parse(await publishGranted.json()).id);
    await writerPage.reload();
    await expect(badgeOf(writerPage)).toHaveText("Draft revision 3");
    await writerPage.locator("[data-agent-publish]").click();
    await writerPage
      .getByRole("dialog", { name: `Publish ${displayName}?` })
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expect(badgeOf(writerPage)).toHaveCount(0);
    expect(await draftRevision(page, name)).toBeNull();
    expect(await liveInstructions(page, name)).toBe("Read the contract three times, slowly.");
  } finally {
    await writerContext.close();
    await readerContext.close();
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
