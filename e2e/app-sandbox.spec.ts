import { randomUUID } from "node:crypto";
import type { FrameLocator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import {
  apiOrigin,
  uiOrigin,
  showView,
  signIn as signInViews,
  viewFrame,
  viewTitle
} from "./view-fixtures";

const admin = { email: "e2e-apps@example.test", password: "e2e-apps-password" };
const member = { email: "e2e-apps-member@example.test", password: "e2e-apps-member-password" };
async function signIn(page: Page, person: typeof admin) {
  const response = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

async function saveApp(page: Page, source: string, script: string, kit = "1.6.0") {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `Sandbox ${randomUUID()}` }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;
  const name = `sandbox-${randomUUID().slice(0, 8)}`;
  const url = `${apiOrigin}/api/v1/assets/app/${name}`;
  const saved = await requestWithOrigin(page, "put", url, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${name}\nname: Leave requests\nkit: ${kit}\nentry: index.html\n`
        },
        {
          path: "index.html",
          text: `<!doctype html><title>Leave requests</title>${source}<script type="module" src="./main.js"></script>`
        },
        { path: "main.js", text: script }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return { workspaceId, name, url, path: `/w/${workspaceId}/app-drafts/${name}` };
}
function appFrame(page: Page): FrameLocator {
  return page.getByTestId("page-preview-frame").contentFrame().frameLocator("iframe");
}

test("an App form validates and fires submit in every sandbox layer", async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page, admin);
  const app = await saveApp(
    page,
    '<form><label>Leave date<input name="date" required></label><button type="submit">Request leave</button></form><output id="result">Not submitted</output>',
    `document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); document.querySelector("#result").textContent = "Submitted " + new FormData(event.target).get("date"); });`
  );
  await page.goto(app.path);
  const frame = appFrame(page);
  await expect(frame.getByRole("button", { name: "Request leave" })).toBeVisible();
  await frame.getByRole("button", { name: "Request leave" }).click();
  await expect(frame.locator("#result")).toHaveText("Not submitted");
  await frame.getByLabel("Leave date").fill("2026-11-01");
  await frame.getByRole("button", { name: "Request leave" }).click();
  await expect(frame.locator("#result")).toHaveText("Submitted 2026-11-01");
  await page.screenshot({ path: testInfo.outputPath("accept-fix-2-form.png") });
  // Publishing the current draft changes the badge in place, without a reload.
  await page.getByTestId("app-edit").getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("app-publish-audience")).toBeVisible();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Published · revision 1", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("accept-fix-2-published-draft.png") });
});

test("agent-style localStorage renders, survives reloads and stays private to the person and App", async ({
  page,
  browser,
  baseURL,
  pageErrors
}, testInfo) => {
  test.setTimeout(180_000);
  await signIn(page, admin);
  const app = await saveApp(
    page,
    '<h1>Leave requests</h1><p id="saved"></p><output id="burst"></output><button id="save">Keep date</button><button id="kit">Save with kit</button><output id="kit-result"></output>',
    `import { storage } from "@work-shape/catalyst-app-kit";
// The pattern agents and customers write: reading storage at module evaluation must not throw.
const current = window.localStorage.getItem("leave-date") || "No date";
document.querySelector("#saved").textContent = current;
document.querySelector("#burst").textContent = localStorage.getItem("burst") || "";
document.querySelector("#save").addEventListener("click", () => { for (let index = 0; index < 100; index++) { if (index % 2 === 0) localStorage.setItem("burst", String(index)); else localStorage.setItem("leave-date", index === 99 ? "2026-11-01" : String(index)); } document.querySelector("#saved").textContent = "2026-11-01"; });
document.querySelector("#kit").addEventListener("click", async () => { await storage.set("filters", { status: "open" }); document.querySelector("#kit-result").textContent = JSON.stringify(await storage.get("filters")); });`
  );
  const otherContext = await browser.newContext({ baseURL });
  await pageErrors.watch(otherContext);
  const otherPage = await otherContext.newPage();
  try {
    await signIn(otherPage, member);
    const joined = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${app.workspaceId}/members`,
      { data: { email: member.email } }
    );
    expect(joined.ok()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${app.url}/publish`, {
      data: { workspaceId: app.workspaceId, revision: 1, audience: "workspace" }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const publishedPath = `/w/${app.workspaceId}/apps/${app.name}`;
    await page.goto(publishedPath);
    await expect(appFrame(page).locator("#saved")).toHaveText("No date");
    // A persistence response, not a sleep or the optimistic DOM change, is the reload barrier.
    const kept = page.waitForResponse(
      (response) =>
        response.url().endsWith("/storage") &&
        response.request().method() === "POST" &&
        response.status() === 200
    );
    await appFrame(page).getByRole("button", { name: "Keep date" }).click();
    const saved = await kept;
    expect(saved.request().postDataJSON()).toMatchObject({
      mutation: { type: "batch", clear: false, values: { burst: "98", "leave-date": "2026-11-01" } }
    });
    expect(saved.headers()["operation-run-id"]).toBeTruthy();
    await page.reload();
    await expect(appFrame(page).locator("#saved")).toHaveText("2026-11-01");
    await expect(appFrame(page).locator("#burst")).toHaveText("98");
    await appFrame(page).getByRole("button", { name: "Save with kit" }).click();
    await expect(appFrame(page).locator("#kit-result")).toHaveText('{"status":"open"}');
    await page.screenshot({ path: testInfo.outputPath("accept-fix-2-storage.png") });
    await otherPage.goto(publishedPath);
    await expect(appFrame(otherPage).locator("#saved")).toHaveText("No date");
    // A new browser session of the same person reads the server snapshot, too.
    const samePerson = await browser.newContext({ baseURL });
    try {
      await pageErrors.watch(samePerson);
      const samePage = await samePerson.newPage();
      await signIn(samePage, admin);
      await samePage.goto(publishedPath);
      await expect(appFrame(samePage).locator("#saved")).toHaveText("2026-11-01");
    } finally {
      await samePerson.close();
    }
    const second = await saveApp(
      page,
      '<p id="saved"></p>',
      'document.querySelector("#saved").textContent = localStorage.getItem("leave-date") || "No date";',
      "1.1.0"
    );
    await page.goto(second.path);
    await expect(appFrame(page).locator("#saved")).toHaveText("No date");
  } finally {
    await otherContext.close();
  }
});

test("a failed chat view shows LoadError and retry loads a working view", async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  const headers = await signInViews(page, uiOrigin);
  const conversation = await showView(page.request, headers, "<p>Quarterly revenue loaded</p>");
  const shell = "**/app-runtime/view-shell/1/shell.html";
  await page.route(shell, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Unavailable</title>" })
  );
  await page.goto(`/c/${conversation.id}`);
  const error = page.locator("[data-load-error]");
  await expect(error).toContainText("This view could not be loaded.");
  await expect(page.getByText("Loading view…", { exact: true })).toBeHidden();
  for (const [theme, locale, width] of [
    ["light", "en", 1280],
    ["dark", "de", 1280],
    ["dark", "en", 390]
  ] as const) {
    await page.evaluate(
      ([mode, language]) => {
        localStorage.setItem("vivd-catalyst:theme", mode);
        localStorage.setItem("vivd-catalyst:locale", language);
      },
      [theme, locale] as const
    );
    await page.setViewportSize({ width, height: 640 });
    await page.reload();
    await expect(error).toContainText(
      locale === "de"
        ? "Diese Ansicht konnte nicht geladen werden."
        : "This view could not be loaded."
    );
    await error.scrollIntoViewIfNeeded();
    await expect(error).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`accept-fix-2-load-error-${theme}-${locale}-${width}.png`)
    });
  }
  await page.unroute(shell);
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(viewFrame(page).getByText("Quarterly revenue loaded")).toBeVisible();
  await expect(error).toBeHidden();
  // Switch away and back twice: an errored shell is not kept for the next selection.
  for (let pass = 0; pass < 2; pass += 1) {
    await page.goto("/");
    await page.goto(`/c/${conversation.id}`);
    await expect(viewFrame(page).getByText("Quarterly revenue loaded")).toBeVisible();
    await expect(page.locator(`iframe[title="${viewTitle}"]`)).toBeVisible();
  }
});
