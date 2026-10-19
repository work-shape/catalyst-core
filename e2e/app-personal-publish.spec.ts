import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

const idSchema = z.object({ id: z.string() });
const revisionSchema = z.object({ revision: z.number() });

async function signIn(page: Page, person: { email: string; password: string }) {
  const response = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: { ...person, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.addInitScript((origin) => {
    if (location.origin === origin) localStorage.setItem("vivd-catalyst:locale", "en");
  }, uiOrigin);
  const workspace = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workspaces/personal`
  );
  expect(workspace.ok()).toBe(true);
  return idSchema.parse(await workspace.json()).id;
}

// ACCEPT-FIX-11 B-1: ownership stays personal, while the instance audience opens the App's
// actual frame and reads rows through its SQL action, without gaining direct store access.
test("a second member opens an instance App built in a personal workspace and reads its data", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(180_000);
  const suffix = randomUUID().slice(0, 8);
  const store = `deadlines-${suffix}`;
  const app = `overview-${suffix}`;
  const title = `Shared deadlines ${suffix}`;
  const owner = await signIn(page, {
    email: process.env.E2E_SUPERADMIN_EMAIL ?? "e2e-superadmin@example.test",
    password: process.env.E2E_SUPERADMIN_PASSWORD ?? "e2e-superadmin-password"
  });
  const member = await browser.newContext({ baseURL });
  await pageErrors.watch(member);
  try {
    const viewer = await member.newPage();
    const viewerWorkspace = await signIn(viewer, {
      email: process.env.E2E_APPS_MEMBER_EMAIL ?? "e2e-apps-member@example.test",
      password: process.env.E2E_APPS_MEMBER_PASSWORD ?? "e2e-apps-member-password"
    });
    const storeAddress = `${apiOrigin}/api/v1/assets/data_store/${store}`;
    const saved = await requestWithOrigin(page, "put", storeAddress, {
      data: {
        workspaceId: owner,
        expectedRevision: null,
        files: [
          { path: "store.yaml", text: `id: ${store}\nname: Deadlines\n` },
          {
            path: "migrations/0001_init.sql",
            text: "create table deadlines (client text primary key, due date not null);"
          }
        ]
      }
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${storeAddress}/publish`, {
      data: { workspaceId: owner, ...revisionSchema.parse(await saved.json()) }
    });
    expect(published.ok(), await published.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const state = await page.request.get(`${apiOrigin}/api/v1/data-stores/${store}`);
          return state.ok() ? state.json() : undefined;
        },
        { timeout: 30_000 }
      )
      .toMatchObject({ status: "ready", level: 1 });
    const inserted = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/data-stores/${store}/insert`,
      { data: { table: "deadlines", rows: [{ client: "Nordlicht", due: "2026-11-01" }] } }
    );
    expect(inserted.ok(), await inserted.text()).toBe(true);
    const appAddress = `${apiOrigin}/api/v1/assets/app/${app}`;
    const written = await requestWithOrigin(page, "put", appAddress, {
      timeout: 90_000,
      data: {
        workspaceId: owner,
        expectedRevision: null,
        files: [
          {
            path: "app.yaml",
            text: JSON.stringify({
              id: app,
              name: title,
              kit: "1.2.0",
              entry: "index.html",
              dataStores: [{ name: store, minSchema: 1 }],
              actions: [{ name: "rows", file: "actions/rows.sql", effect: "reading" }]
            })
          },
          { path: "actions/rows.sql", text: "select client, due from deadlines order by client" },
          {
            path: "index.html",
            text: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p id="rows">Loading</p><script type="module">import { actions } from "@work-shape/catalyst-app-kit"; const output = document.getElementById("rows"); try { const answer = await actions.call("rows", {}); output.textContent = JSON.stringify(answer.result.rows); } catch (error) { output.textContent = error.message; }</script></body></html>`
          }
        ]
      }
    });
    expect(written.ok(), await written.text()).toBe(true);
    const shared = await requestWithOrigin(page, "post", `${appAddress}/publish`, {
      data: {
        workspaceId: owner,
        audience: "instance",
        ...revisionSchema.parse(await written.json())
      }
    });
    expect(shared.ok(), await shared.text()).toBe(true);
    await viewer.goto(`/w/${viewerWorkspace}/apps`);
    await viewer
      .getByRole("link", { name: new RegExp(`^(?:Open ${title}|${title} öffnen)$`, "u") })
      .click();
    await expect(viewer).toHaveURL(`${uiOrigin}/w/${viewerWorkspace}/apps/${app}`);
    const frame = viewer
      .getByTestId("app-view")
      .getByTestId("page-preview-frame")
      .contentFrame()
      .frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: title })).toBeVisible();
    await expect(frame.locator("#rows")).toContainText("Nordlicht");
    await expect(frame.locator("#rows")).toContainText("2026-11-01");
    if (process.env.E2E_SHOTS_DIR) {
      await mkdir(process.env.E2E_SHOTS_DIR, { recursive: true });
      await viewer.screenshot({
        path: join(process.env.E2E_SHOTS_DIR, "02-second-member-app-frame.png")
      });
    }
    expect((await viewer.request.get(`${apiOrigin}/api/v1/data-stores/${store}`)).status()).toBe(
      403
    );
    // Opening the same instance App from a team workspace keeps that workspace in place.
    const team = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
      data: { name: `Shared App team ${suffix}` }
    });
    expect(team.ok()).toBe(true);
    const teamId = idSchema.parse(await team.json()).id;
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${teamId}/members`,
      {
        data: { email: process.env.E2E_APPS_MEMBER_EMAIL ?? "e2e-apps-member@example.test" }
      }
    );
    expect(added.ok()).toBe(true);
    await viewer.goto(`/w/${teamId}/apps`);
    await viewer
      .getByRole("link", { name: new RegExp(`^(?:Open ${title}|${title} öffnen)$`, "u") })
      .click();
    await expect(viewer).toHaveURL(`${uiOrigin}/w/${teamId}/apps/${app}`);
    await expect(frame.locator("#rows")).toContainText("Nordlicht");
    const usage = await page.request.get(`${apiOrigin}/api/v1/data-stores/${store}/used-by`);
    expect(usage.ok()).toBe(true);
    expect(await usage.json()).toMatchObject({
      apps: [{ audience: { app: { audience: "instance" } } }]
    });
  } finally {
    await member.close();
  }
});
