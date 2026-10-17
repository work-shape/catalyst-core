import { seedHistoricalGrant } from "./legacy-grant";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./test";
import { closeToolPackage, openToolPackage, switchToolPackage, toolRow } from "./tool-packages";
import { loadNewerVersion } from "./build-fixtures";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Where the pictures of the conflict notice go, and in which theme. Unset, none is taken. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const shotsTheme = process.env.E2E_SHOTS_THEME === "dark" ? "dark" : "light";
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };
const namespacePath = `${apiBaseUrl}/api/v1/instance/access/namespaces`;
const grantsPath = `${apiBaseUrl}/api/v1/instance/access/grants`;
const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;
/** The reads Studio made before it worked on the asset operations: the whole set of assets. */
const WHOLE_SET_READ = /\/api\/v1\/instance\/config\/(?:assets|export)(?:\?|$)/u;

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A field of an answer of the instance, read without trusting its shape. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function textField(value: unknown, key: string): string {
  const found = field(value, key);
  if (typeof found !== "string") {
    throw new Error(`The answer has no text at ${key}`);
  }
  return found;
}

function items(value: unknown): unknown[] {
  const found = field(value, "items");
  return Array.isArray(found) ? found : [];
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

function agentList(page: Page): Locator {
  return page.getByRole("list", { name: "Agents" });
}

function instructions(page: Page): Locator {
  return page.locator("form").getByRole("textbox", { name: /^System prompt/u });
}

/** Deletes an agent if it is there. What a test leaves behind must not meet the next run. */
async function deleteAgent(admin: Page, name: string): Promise<void> {
  const found = await admin.request.get(agentPath(name));
  if (found.ok()) {
    await requestWithOrigin(admin, "post", `${agentPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(admin, agentPath(name)) }
    });
  }
}

test("a Namespace holder builds an agent in the Namespace, is refused, meets a conflict and restores", async ({
  page,
  browser,
  pageErrors,
  // The test stores two agents; the turn on the agents holds the one on the Namespaces.
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(120_000);
  const adminContext = await browser.newContext();
  await pageErrors.watch(adminContext);
  const admin = await adminContext.newPage();
  await signInViaApi(admin, superadminUser);

  // A person of their own, so that no other spec meets the rights this one hands out.
  const stamp = Date.now();
  const holder = {
    displayLabel: `E2E Builder ${stamp}`,
    email: `e2e-builder-${stamp}@example.test`,
    password: `e2e-builder-${stamp}`
  };
  const createdUser = await requestWithOrigin(
    admin,
    "post",
    `${apiBaseUrl}/api/v1/instance/users`,
    {
      data: {
        displayLabel: holder.displayLabel,
        email: holder.email,
        roles: ["user"],
        passwordSignIn: { password: holder.password }
      }
    }
  );
  expect(createdUser.ok()).toBe(true);
  const holderId = textField(await createdUser.json(), "id");

  try {
    // A historical Namespace grant still lets this holder build under kai-. Its tool limit still applies.
    const namespace = await requestWithOrigin(admin, "post", namespacePath, {
      data: { prefix: "kai-", displayName: "Kai", allowedToolNames: ["show_view"] }
    });
    expect(namespace.ok()).toBe(true);
    const context: unknown = await (await admin.request.get(`${apiBaseUrl}/api/v1/context`)).json();
    const kinds: unknown = field(context, "kinds");
    const agentKind: unknown = (Array.isArray(kinds) ? kinds : []).find(
      (kind: unknown) => field(kind, "kind") === "agent"
    );
    for (const verb of ["read", "write", "delete"]) {
      await seedHistoricalGrant(admin, {
        holderId,
        action: textField(field(agentKind, "actions"), verb),
        namespace: "kai-"
      });
    }
    const first = await requestWithOrigin(admin, "put", agentPath("kai-first"), {
      data: {
        expectedRevision: await assetBaseRevision(admin, agentPath("kai-first")),
        config: {
          name: "kai-first",
          displayName: "Kai First",
          modelProviderId: "local",
          instructions: "You were here first.",
          toolNames: []
        }
      }
    });
    expect(first.ok()).toBe(true);

    // The holder has a Studio row and sees the agents of the Namespace, nothing else.
    const wholeSetReads: string[] = [];
    page.on("request", (request) => {
      if (WHOLE_SET_READ.test(request.url())) {
        wholeSetReads.push(request.url());
      }
    });
    await signInViaApi(page, holder);
    await page.setViewportSize(WIDE);
    await page.goto("/");
    await page.getByRole("button", { name: "Studio", exact: true }).click();
    await expect(page).toHaveURL(/\/build\/agents$/u);
    await expect(agentList(page).getByRole("link")).toHaveCount(1);
    await expect(agentList(page).getByRole("link", { name: /Kai First/u })).toContainText("Kai");
    await expect(page.getByText("Research Assistant")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Kinds in Studio" })).toHaveCount(0);

    // A new agent is named in the Namespace: the dialog says what the id will be.
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New agent", exact: true });
    await create.getByRole("textbox", { name: /^Display name/u }).fill("Kai Helper");
    await create.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(create.getByText("The full address will be kai-kai_helper.")).toBeVisible();
    await create.getByRole("textbox", { name: /^Address/u }).fill("helper");
    await expect(create.getByText("The full address will be kai-helper.")).toBeVisible();
    // Made outside a shared workspace by somebody who may not widen it, the agent starts hidden.
    await expect(
      create.getByText("Hidden until an instance admin makes it available")
    ).toBeVisible();
    await expect(create.getByRole("combobox", { name: "Available in" })).toHaveCount(0);
    await create.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Kai Helper", level: 1 })).toBeVisible();
    await instructions(page).fill("You help Kai.");

    // A tool outside the Namespace's list is refused, and the refusal stands at the tools.
    const tools = page.locator("#tools");
    // An own tool of the instance is turned on with its row's switch.
    await switchToolPackage(tools, "own:demo.weather_forecast", true);
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    await expect(tools.locator("[data-field-refusal]")).toHaveText(
      "The tool demo.weather_forecast is not allowed in Namespace kai-."
    );
    await expect(instructions(page)).toHaveValue("You help Kai.");
    await switchToolPackage(tools, "own:demo.weather_forecast", false);
    // A package's switch turns all its tools on; its folded tools take the one not wanted off.
    await switchToolPackage(tools, "package:results", true);
    const results = await openToolPackage(tools, "package:results");
    await results.getByRole("checkbox", { name: "Open in preview" }).uncheck();
    await closeToolPackage(tools, "package:results");
    await expect(toolRow(tools, "package:results").locator("[data-tool-count]")).toHaveText("1/2");
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    await expect(page).toHaveURL(/\/build\/agents\/kai-helper$/u);
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    // An id that was used before keeps its history, so the revisions are counted from here.
    const created = await assetRevision(admin, agentPath("kai-helper"));

    // A change shows the save bar with its count, and a save hides it again.
    await instructions(page).fill("You help Kai every day.");
    await expect(page.getByText("1 change", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    await expect.poll(() => assetRevision(admin, agentPath("kai-helper"))).toBe(created + 1);

    // Somebody else saves while the holder types: the holder's save meets the newer revision,
    // overwrites nothing and keeps the text.
    await instructions(page).fill("The holder's unsaved text.");
    await admin.setViewportSize(WIDE);
    await admin.goto("/build/agents/kai-helper");
    await instructions(admin).fill("The administrator was faster.");
    await admin.getByRole("button", { name: "Save changes", exact: true }).click();
    // The button loses its name while it saves, so the revision says when the save is there.
    await expect.poll(() => assetRevision(admin, agentPath("kai-helper"))).toBe(created + 2);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const conflict = page.locator("[data-build-conflict]");
    // Fails without the change: the notice said "Somebody" and offered no way to the history.
    await expect(conflict).toContainText(/saved this on .+, while you were editing\./u);
    await expect(conflict).not.toContainText("Somebody");
    await expect(instructions(page)).toHaveValue("The holder's unsaved text.");
    await expect.poll(() => assetRevision(admin, agentPath("kai-helper"))).toBe(created + 2);
    // While the conflict stands nothing is saved, and History restores nothing: the page
    // holds an older version than the newest one, which History marks as the current one.
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await conflict.getByRole("button", { name: "Open history", exact: true }).click();
    const staleHistory = page.getByRole("dialog", { name: "History", exact: true });
    await expect(staleHistory.locator(`[data-revision="${created + 2}"]`)).toContainText("Current");
    await expect(staleHistory.locator(`[data-revision="${created + 1}"]`)).not.toContainText(
      "Current"
    );
    await expect(staleHistory.getByRole("button", { name: /^Restore revision/u })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(staleHistory).toBeHidden();
    await loadNewerVersion(page);
    await expect(conflict).toHaveCount(0);
    await expect(instructions(page)).toHaveValue("The administrator was faster.");

    // History lists the revisions beside the editor, and the first one comes back.
    await page.getByRole("button", { name: "History", exact: true }).click();
    const history = page.getByRole("dialog", { name: "History", exact: true });
    for (const revision of [created, created + 1, created + 2]) {
      await expect(history.locator(`[data-revision="${revision}"]`)).toBeVisible();
    }
    await history.getByRole("button", { name: `Restore revision ${created}`, exact: true }).click();
    await page
      .getByRole("dialog", { name: `Restore revision ${created}?`, exact: true })
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    // The restored content is the asset now: the drawer closes on the editor that shows it.
    await expect(history).toBeHidden();
    await expect(page.locator("[data-build-restored]")).toHaveText(`Revision ${created} restored.`);
    await expect(instructions(page)).toHaveValue("You help Kai.");
    await expect.poll(() => assetRevision(admin, agentPath("kai-helper"))).toBe(created + 3);

    // The list holds both agents now, and the holder deletes the one they made.
    await page.getByRole("button", { name: "Back to Agents", exact: true }).click();
    await expect(agentList(page).getByRole("link")).toHaveCount(2);
    await agentList(page)
      .getByRole("link", { name: /Kai Helper/u })
      .click();
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Delete agent 'kai-helper'?", exact: true })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(page).toHaveURL(/\/build\/agents$/u);
    await expect(agentList(page).getByRole("link")).toHaveCount(1);

    // An agent outside the Namespace is not the holder's: its address says so in the reader's
    // language and offers nothing to try again.
    await page.goto("/build/agents/research_assistant");
    await expect(page.getByText("You may not read this asset.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Research Assistant" })).toHaveCount(0);
    await expect(instructions(page)).toHaveCount(0);

    // Nothing on the way read the whole set of assets.
    expect(wholeSetReads).toEqual([]);
  } finally {
    await deleteAgent(admin, "kai-helper");
    await deleteAgent(admin, "kai-first");
    const grants: unknown = await (
      await admin.request.get(`${grantsPath}?holderKind=user&holderId=${holderId}`)
    ).json();
    for (const grant of items(grants)) {
      await requestWithOrigin(admin, "delete", `${grantsPath}/${textField(grant, "id")}`);
    }
    await requestWithOrigin(admin, "delete", `${namespacePath}/kai-`);
    await requestWithOrigin(admin, "delete", `${apiBaseUrl}/api/v1/instance/users/${holderId}`);
    await adminContext.close();
  }
});

test("a user with no right on an agent or a skill has no Studio row and is told so at its address", async ({
  page,
  accessState: _accessState
}) => {
  await signInViaApi(page, normalUser);
  await page.goto("/");
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  await expect(page.getByRole("button", { name: "Studio", exact: true })).toHaveCount(0);

  await page.goto("/build");
  await expect(page.getByRole("region", { name: "Studio" })).toContainText(
    "Studio is not available to you."
  );
  await expect(page).toHaveURL(/\/build$/u);
  await page.goto("/build/agents/research_assistant");
  await expect(page.getByRole("region", { name: "Studio" })).toContainText(
    "Studio is not available to you."
  );
  await expect(page.getByRole("heading", { name: "Research Assistant" })).toHaveCount(0);
});

test("the old Config address leads into Studio, and the account menu names the instance and its release", async ({
  page
}) => {
  await signInViaApi(page, superadminUser);
  await page.goto("/admin/config");
  await expect(page).toHaveURL(/\/build\/agents$/u);
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: / account$/u }).click();
  const identity = page.getByRole("menu").locator("[data-platform-identity]");
  await expect(identity).toContainText("Demo E2E Client Instance");
  await expect(identity).toContainText(/Version \d+\.\d+/u);
});

/**
 * The probes below are skills, not agents: an agent of the instance would show in the chat's
 * agent picker for as long as it lives, under the tests of other files that count its options.
 */
const skillPath = (name: string) => `${apiBaseUrl}/api/v1/assets/skill/${name}`;

function content(page: Page): Locator {
  return page.locator("form").getByRole("textbox", { name: /^Content/u });
}

async function deleteSkill(admin: Page, name: string): Promise<void> {
  const found = await admin.request.get(skillPath(name));
  if (found.ok()) {
    await requestWithOrigin(admin, "post", `${skillPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(admin, skillPath(name)) }
    });
  }
}

/** A skill of this spec's own, written by the administrator. */
async function putSkill(admin: Page, name: string, text: string): Promise<void> {
  const answer = await requestWithOrigin(admin, "put", skillPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(admin, skillPath(name)),
      config: {
        name,
        title: "Reload Probe",
        description: "A probe of the Studio tests.",
        content: text
      }
    }
  });
  expect(answer.ok()).toBe(true);
}

test("a newer version that cannot be loaded leaves the page as it is and says so", async ({
  page
}) => {
  const name = "e2e_reload_probe";
  await signInViaApi(page, superadminUser);
  await deleteSkill(page, name);
  await putSkill(page, name, "The first text.");
  try {
    if (shotsDir) {
      await page.addInitScript(
        (theme) => window.localStorage.setItem("vivd-catalyst:theme", theme),
        shotsTheme
      );
    }
    await page.setViewportSize(WIDE);
    await page.goto(`/build/skills/${name}`);
    await content(page).fill("My unsaved text.");
    await putSkill(page, name, "Somebody else was faster.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const conflict = page.locator("[data-build-conflict]");
    await expect(conflict).toContainText(
      /E2E Superadmin saved this on .+, while you were editing\./u
    );
    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      await page.screenshot({
        path: join(shotsDir, `build-conflict-${shotsTheme}.png`),
        animations: "disabled"
      });
    }

    // The read behind "Load the newer version" fails: the notice stays, the text stays, and
    // the page says that the load failed. It does not show the old version as the new one.
    const assetRead = (url: URL) => url.pathname === `/api/v1/assets/skill/${name}`;
    await page.route(assetRead, (route) =>
      route.request().method() === "GET" ? route.abort("failed") : route.fallback()
    );
    await loadNewerVersion(page);
    await expect(page.locator("[data-build-reload-failed]")).toHaveText(
      "The newer version could not be loaded. Your text is still here. Try again in a moment."
    );
    await expect(conflict).toBeVisible();
    await expect(content(page)).toHaveValue("My unsaved text.");
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();

    // With the instance back, the same button loads the newer version.
    await page.unroute(assetRead);
    await loadNewerVersion(page);
    await expect(conflict).toHaveCount(0);
    await expect(content(page)).toHaveValue("Somebody else was faster.");
  } finally {
    await deleteSkill(page, name);
  }
});

// Fails without the change: the notice stood in the row that stays at the lower edge, and with
// its three sentences and two buttons it took most of a phone's window, over the text it is
// about.
test("the notice of a newer version leaves the text in reach on a phone, in German", async ({
  page
}) => {
  const name = "e2e_phone_probe";
  await page.addInitScript(
    (theme) => {
      window.localStorage.setItem("vivd-catalyst:locale", "de");
      if (theme) window.localStorage.setItem("vivd-catalyst:theme", theme);
    },
    shotsDir ? shotsTheme : undefined
  );
  await signInViaApi(page, superadminUser);
  await deleteSkill(page, name);
  await putSkill(page, name, "The first text.");
  try {
    await page.setViewportSize(NARROW);
    await page.goto(`/build/skills/${name}`);
    const text = page.locator("form").getByRole("textbox", { name: /^Inhalt/u });
    await text.fill("Mein ungespeicherter Text.");
    await putSkill(page, name, "Somebody else was faster.");
    await page.getByRole("button", { name: "Änderungen speichern", exact: true }).click();
    const conflict = page.locator("[data-build-conflict]");
    await expect(conflict).toContainText(
      "Die neuere Version zu laden ersetzt deinen Text. Kopiere vorher, was du behalten willst."
    );
    await expect(conflict.getByRole("button", { name: "Neuere Version laden" })).toBeVisible();
    await expect(conflict.getByRole("button", { name: "Verlauf öffnen" })).toBeVisible();
    await expectNoSidewaysScroll(page);
    if (shotsDir) {
      await mkdir(shotsDir, { recursive: true });
      await page.screenshot({
        path: join(shotsDir, `build-conflict-de-390-${shotsTheme}.png`),
        animations: "disabled"
      });
    }

    // The notice is in the window when it appears. It rests at the end of the page, so the
    // text scrolls into the window whole, with nothing over it.
    await expect(conflict).toBeInViewport({ ratio: 1 });
    await text.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(text).toBeInViewport({ ratio: 1 });
    const textBox = await text.boundingBox();
    const footerBox = await page.locator("[data-page-footer]").boundingBox();
    if (!textBox || !footerBox) throw new Error("The text and the footer are on the page");
    expect(textBox.y + textBox.height).toBeLessThanOrEqual(footerBox.y);
    await expect(text).toHaveValue("Mein ungespeicherter Text.");
    if (shotsDir) {
      await page.screenshot({
        path: join(shotsDir, `build-conflict-de-390-text-${shotsTheme}.png`),
        animations: "disabled"
      });
    }
  } finally {
    await deleteSkill(page, name);
  }
});

test("an asset that was deleted meanwhile says so, keeps the text and offers the way out", async ({
  page
}) => {
  const name = "e2e_deleted_probe";
  await signInViaApi(page, superadminUser);
  await deleteSkill(page, name);
  await putSkill(page, name, "The first text.");
  try {
    await page.setViewportSize(WIDE);

    // Deleted before the save: the notice names the delete, not a save.
    await page.goto(`/build/skills/${name}`);
    await content(page).fill("My unsaved text.");
    await deleteSkill(page, name);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const deleted = page.locator('[data-build-conflict="deleted"]');
    await expect(deleted).toContainText(
      /E2E Superadmin deleted this on .+, while you were editing\./u
    );
    await expect(page.getByText("saved this", { exact: false })).toHaveCount(0);
    await expect(content(page)).toHaveValue("My unsaved text.");
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await expect(
      deleted.getByRole("button", { name: "Load the newer version", exact: true })
    ).toHaveCount(0);

    // History still reads, and restores nothing that would end in the same notice.
    await page.getByRole("button", { name: "History", exact: true }).click();
    const history = page.getByRole("dialog", { name: "History", exact: true });
    await expect(history.locator("[data-revision]").first()).toContainText("Deleted");
    await expect(history.getByRole("button", { name: /^Restore revision/u })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(history).toBeHidden();

    // The way out leads to the list without another question.
    await deleted.getByRole("button", { name: "Back to Skills", exact: true }).click();
    await expect(page).toHaveURL(/\/build\/skills$/u);

    // Saved first and deleted after: the page learns of the delete when it asks for the
    // newer version, and does not show the deleted skill as if it were there.
    await putSkill(page, name, "The second life.");
    await page.goto(`/build/skills/${name}`);
    await content(page).fill("My other unsaved text.");
    await putSkill(page, name, "Somebody else was faster.");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.locator('[data-build-conflict="saved"]')).toBeVisible();
    await deleteSkill(page, name);
    await loadNewerVersion(page);
    await expect(deleted).toContainText("Somebody deleted this while you were editing.");
    await expect(page.locator('[data-build-conflict="saved"]')).toHaveCount(0);
    await expect(content(page)).toHaveValue("My other unsaved text.");
  } finally {
    await deleteSkill(page, name);
  }
});

test("an agent's availability and the default agent are changed by the asset operations", async ({
  page,
  // The agent is offered in every workspace from the moment it is stored until the test
  // narrows it, so the tests that count the agents of the instance wait for this one.
  instanceAgentsChange: _instanceAgentsChange
}) => {
  const name = "e2e_placement_probe";
  await signInViaApi(page, superadminUser);
  await deleteAgent(page, name);
  const created = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath(name)),
      availableIn: "all",
      config: {
        name,
        displayName: "Placement Probe",
        modelProviderId: "local",
        instructions: "A probe of the Studio tests.",
        toolNames: []
      }
    }
  });
  expect(created.ok()).toBe(true);
  try {
    await page.setViewportSize(WIDE);
    await page.goto(`/build/agents/${name}`);
    const everywhere = page.getByRole("radio", { name: "All workspaces" });
    const selected = page.getByRole("radio", { name: "Selected workspaces" });
    const personal = page.getByRole("checkbox", { name: "Personal workspaces" });
    await expect(everywhere).toBeChecked();

    // The availability is saved through the page's one save bar, by the asset operation,
    // whose call is an Operation Run. The agent itself did not change and is not written.
    const agentWrites: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "PUT" && path === new URL(agentPath(name)).pathname) {
        agentWrites.push(request.url());
      }
    });
    const saveBar = page.getByRole("button", { name: "Save changes", exact: true });
    await expect(saveBar).toHaveCount(0);
    await selected.click();
    await personal.click();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/v1/assets/agent/${name}/availability`
    );
    await saveBar.click();
    const answer = await saved;
    expect(answer.status()).toBe(200);
    expect(answer.headers()["operation-run-id"]).toBeTruthy();
    expect(await answer.json()).toEqual({
      mode: "selected",
      personalWorkspaces: true,
      collaborationWorkspaceIds: []
    });
    await expect(saveBar).toHaveCount(0);
    expect(agentWrites).toEqual([]);
    expect(field(await (await page.request.get(agentPath(name))).json(), "availability")).toEqual({
      mode: "selected",
      personalWorkspaces: true,
      collaborationWorkspaceIds: []
    });

    // The page that is loaded again shows what was stored.
    await page.reload();
    await expect(selected).toBeChecked();
    await expect(personal).toBeChecked();

    // The default is asked of the asset operation too. An agent that is not offered everywhere
    // cannot be the default: the instance refuses, the page says so in the instance's words,
    // and the default every other test runs with stays as it was.
    const asked = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/assets/agent/default"
    );
    await page.getByRole("button", { name: "Make default", exact: true }).click();
    const refused = await asked;
    // The call names the agent the page shows, so another one of the name is not made default.
    expect(refused.request().postDataJSON()).toEqual({
      name,
      expectedAssetId: field(await (await page.request.get(agentPath(name))).json(), "id")
    });
    expect(refused.status()).toBe(422);
    expect(refused.headers()["operation-run-id"]).toBeTruthy();
    await expect(
      page.getByText(`Default agent '${name}' must be available in all workspaces`)
    ).toBeVisible();
  } finally {
    await deleteAgent(page, name);
  }
});

test("a long history comes a page at a time", async ({ page }) => {
  const name = "e2e_history_probe";
  await signInViaApi(page, superadminUser);
  await deleteSkill(page, name);
  await putSkill(page, name, "The text.");
  try {
    await page.setViewportSize(WIDE);
    // Two revisions more than one page holds. The instance answers the first read with its
    // one revision, and this test makes 52 of its shape: writing them would put some 150
    // calls on the instance's record under the tests of other files that read its first page.
    // The paging of the instance itself is held in tests/asset-operation-bounds.test.ts.
    const reads: URLSearchParams[] = [];
    await page.route(
      (url) => url.pathname === `/api/v1/assets/skill/${name}/revisions`,
      async (route) => {
        const asked = new URL(route.request().url()).searchParams;
        reads.push(asked);
        const response = await route.fetch({
          url: route.request().url().replace(/\?.*$/u, "?limit=1")
        });
        const real: unknown = await response.json();
        const stored = items(real)[0];
        const older = asked.has("cursor");
        const numbers = older ? [2, 1] : Array.from({ length: 50 }, (_, index) => 52 - index);
        await route.fulfill({
          response,
          json: {
            items: numbers.map((revision) => ({
              ...(typeof stored === "object" ? stored : {}),
              revision,
              operation: revision === 1 ? "create" : "update"
            })),
            ...(older ? {} : { nextCursor: "after-three" })
          }
        });
      }
    );
    await page.goto(`/build/skills/${name}`);
    await page.getByRole("button", { name: "History", exact: true }).click();
    const history = page.getByRole("dialog", { name: "History", exact: true });
    const rows = history.locator("[data-revision]");
    await expect(rows).toHaveCount(50);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.get("limit")).toBe("50");
    expect(reads[0]?.has("cursor")).toBe(false);

    await history.getByRole("button", { name: "Show more", exact: true }).click();
    await expect(rows).toHaveCount(52);
    await expect(history.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.get("limit")).toBe("50");
    expect(reads[1]?.get("cursor")).toBe("after-three");
    // One current revision, the newest.
    await expect(history.getByText("Current", { exact: true })).toHaveCount(1);
    await expect(rows.first()).toContainText("Current");
  } finally {
    await deleteSkill(page, name);
  }
});

for (const locale of ["en", "de"] as const) {
  for (const mode of ["light", "dark"] as const) {
    test(`Studio keeps inside the window at both widths (${locale}, ${mode})`, async ({ page }) => {
      await page.addInitScript((chosen) => {
        window.localStorage.setItem("vivd-catalyst:locale", chosen);
      }, locale);
      await page.emulateMedia({ colorScheme: mode });
      await signInViaApi(page, superadminUser);
      const words =
        locale === "en"
          ? { agents: "Agents", sections: "On this page", history: "History", more: "More actions" }
          : {
              agents: "Agenten",
              sections: "Auf dieser Seite",
              history: "Verlauf",
              more: "Weitere Aktionen"
            };

      for (const size of [WIDE, NARROW]) {
        await page.setViewportSize(size);
        await page.goto("/build/agents");
        await expect(page.getByRole("heading", { name: words.agents, level: 1 })).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator("main")
              .first()
              .evaluate((element) => element.classList.contains("dark"))
          )
          .toBe(mode === "dark");
        await expect(
          page.getByRole("list", { name: words.agents }).getByRole("link").first()
        ).toBeVisible();
        await expectNoSidewaysScroll(page);

        await page.goto("/build/agents/research_assistant");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        // Links beside the content while there is room for it, a choice above it otherwise.
        const outline = page.getByRole("navigation", { name: words.sections });
        await expect(outline).toBeVisible();
        await expect(outline.getByRole("link").first()).toBeVisible({
          visible: size === WIDE
        });
        await expect(outline.getByRole("combobox")).toBeVisible({ visible: size === NARROW });
        await expectNoSidewaysScroll(page);

        // Where the head has no room for History beside the rest, it stands in the "…" menu.
        const historyButton = page
          .locator("header[data-page-head]")
          .getByRole("button", { name: words.history, exact: true });
        if ((await historyButton.count()) > 0) {
          await historyButton.click();
        } else {
          await page.getByRole("button", { name: words.more, exact: true }).click();
          await page.getByRole("menuitem", { name: words.history, exact: true }).click();
        }
        const history = page.getByRole("dialog", { name: words.history, exact: true });
        await expect(history.locator("[data-revision]").first()).toBeVisible();
        await expectNoSidewaysScroll(page);
        await page.keyboard.press("Escape");
        await expect(history).toBeHidden();
      }
    });
  }
}
