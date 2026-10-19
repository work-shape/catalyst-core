import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

const idSchema = z.object({ id: z.string() });
const revisionSchema = z.object({ revision: z.number() });

// ACCEPT-FIX-11 E-1: an actual page observes a background state transition and a confirmed
// chat write. No navigation or reload happens between either change and the visible result.
test("a Data Store follows setup and shows a row written from its chat without reloading", async ({
  page
}) => {
  test.setTimeout(180_000);
  const signed = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: {
      email: process.env.E2E_SUPERADMIN_EMAIL ?? "e2e-superadmin@example.test",
      password: process.env.E2E_SUPERADMIN_PASSWORD ?? "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signed.ok()).toBe(true);
  const personal = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces/personal`);
  const workspaceId = idSchema.parse(await personal.json()).id;
  await page.addInitScript((origin) => {
    if (location.origin === origin) localStorage.setItem("vivd-catalyst:locale", "en");
  }, uiOrigin);
  const name = `refresh-${randomUUID().slice(0, 8)}`;
  const address = `${apiOrigin}/api/v1/assets/data_store/${name}`;
  const written = await requestWithOrigin(page, "put", address, {
    data: {
      expectedRevision: null,
      files: [
        { path: "store.yaml", text: `id: ${name}\nname: Refresh deadlines\n` },
        {
          path: "migrations/0001_init.sql",
          text: "create table deadlines (client text primary key, done boolean not null);"
        }
      ]
    }
  });
  expect(written.ok(), await written.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${address}/publish`, {
    data: revisionSchema.parse(await written.json())
  });
  expect(published.ok(), await published.text()).toBe(true);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${apiOrigin}/api/v1/data-stores/${name}`);
        return response.ok() ? response.json() : undefined;
      },
      { timeout: 30_000 }
    )
    .toMatchObject({ status: "ready", level: 1 });
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/conversations`, {
    data: {
      collaborationWorkspaceId: workspaceId,
      subject: { kind: "data_store", name }
    }
  });
  expect(created.ok()).toBe(true);
  const conversationId = idSchema.parse(await created.json()).id;
  let firstState = true;
  await page.route(`${apiOrigin}/api/v1/data-stores/${name}`, async (route) => {
    const response = await route.fetch();
    if (firstState) {
      firstState = false;
      const state: unknown = await response.json();
      const parsed = z.record(z.string(), z.unknown()).parse(state);
      await route.fulfill({ response, json: { ...parsed, status: "provisioning", level: 0 } });
    } else {
      await route.fulfill({ response });
    }
  });
  await page.goto(`/build/data-stores/${name}?chat=${conversationId}`);
  const status = page.locator("#status");
  await expect(status).toContainText(/Setting up|Wird eingerichtet/u);
  await expect(status).toContainText(/Ready|Bereit/u, { timeout: 15_000 });
  await expect(page.locator("#rows")).toContainText(
    /This table holds no rows|Diese Tabelle enthält keine Zeilen/u
  );
  await page
    .getByRole("textbox")
    .fill(
      `/tool data_store.${name}.insert ${JSON.stringify({ table: "deadlines", rows: [{ client: "Nordlicht", done: false }] })}`
    );
  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
  await page.getByRole("button", { name: /^(?:Allow|Erlauben)$/u }).click({ timeout: 90_000 });
  await expect(page.locator('[data-data-store-rows="deadlines"]')).toContainText("Nordlicht", {
    timeout: 30_000
  });
  if (process.env.E2E_SHOTS_DIR) {
    await mkdir(process.env.E2E_SHOTS_DIR, { recursive: true });
    await page.locator("#rows").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(process.env.E2E_SHOTS_DIR, "05-refresh-story-fresh-chrome.png")
    });
  }
});
