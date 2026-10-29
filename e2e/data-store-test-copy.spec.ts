import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// DT-2: the Data Store page shows the store's test copy, the scratch database a draft's calls
// reach, with its level, seed files and size against its own limit, and resets and deletes it
// through the instance. The copy is made here by the reset route, as the CLI makes it; a draft's
// first changing call makes it the same way (tests/data-store-test-copy.test.ts).

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const copySchema = z.object({
  testCopy: z.object({ level: z.number(), seedFiles: z.number(), limitBytes: z.number() })
});

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

test("the Data Store page shows the test copy, resets it and deletes it", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const store = `e2e-copy-${tag}`;
  const title = `Findings ${tag}`;
  const storeUrl = `${apiBaseUrl}/api/v1/assets/data_store/${store}`;
  const put = await requestWithOrigin(page, "put", storeUrl, {
    data: {
      expectedRevision: null,
      files: [
        { path: "store.yaml", text: `id: ${store}\nname: ${title}\n` },
        {
          path: "migrations/0001_init.sql",
          text: "create table findings (id text primary key, body text not null);\n"
        },
        {
          path: "seed/0001_examples.sql",
          text: "insert into findings (id, body) values ('seed-1', 'An example');\n"
        }
      ]
    }
  });
  expect(put.ok(), await put.text()).toBe(true);
  try {
    const published = await requestWithOrigin(page, "post", `${storeUrl}/publish`, {
      data: { revision: 1 }
    });
    expect(published.ok(), await published.text()).toBe(true);
    await expect
      .poll(
        async () =>
          (await page.request.get(`${apiBaseUrl}/api/v1/data-stores/${store}/describe`)).status(),
        { timeout: 30_000 }
      )
      .toBe(200);

    await page.goto("/");
    await page.evaluate(() => {
      window.localStorage.setItem("vivd-catalyst:locale", "en");
      window.localStorage.setItem("vivd-catalyst:build-scope", "instance");
    });
    await page.goto(`/build/data-stores/${store}`);
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    const section = page.locator('[id="test-copy"]');
    await expect(section.locator('[data-data-store-test-copy="absent"]')).toContainText(
      "A draft's first call that changes the store makes it."
    );

    const reset = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/data-stores/${store}/test-copy/reset`
    );
    expect(reset.ok(), await reset.text()).toBe(true);
    expect(copySchema.parse(await reset.json()).testCopy).toMatchObject({
      level: 1,
      seedFiles: 1
    });
    // The seed row is the copy's alone: the live store holds none.
    const liveRows = await page.request.get(
      `${apiBaseUrl}/api/v1/data-stores/${store}/rows?table=findings`
    );
    expect(liveRows.ok(), await liveRows.text()).toBe(true);
    expect(await liveRows.json()).toMatchObject({ rows: [] });

    await page.reload();
    const present = section.locator('[data-data-store-test-copy="present"]');
    await expect(present).toContainText("Seed files");
    await expect(present).toContainText("500 MB");

    const resetAnswer = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/v1/data-stores/${store}/test-copy/reset`
    );
    await section.locator("[data-data-store-test-copy-reset]").click();
    expect((await resetAnswer).ok()).toBe(true);
    await expect(section.locator("[data-data-store-test-copy-failed]")).toHaveCount(0);
    await expect(present).toBeVisible();

    await section.locator("[data-data-store-test-copy-delete]").click();
    await expect(section.locator('[data-data-store-test-copy="absent"]')).toBeVisible();
    await expect(section.locator("[data-data-store-test-copy-failed]")).toHaveCount(0);
  } finally {
    const deleted = await requestWithOrigin(page, "post", `${storeUrl}/delete`, {
      data: { expectedRevision: await assetRevision(page, storeUrl) }
    });
    expect(deleted.ok()).toBe(true);
  }
});
