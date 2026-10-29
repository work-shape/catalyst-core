import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// The Apps and the projects in the rail stand alphabetically (Felix, 2026-10-29: the app he
// clicks on always moved to the top). Opening the second one, and then the others, leaves the
// order as it was. They are made in the reverse of their alphabet, so an order of use would put
// the one opened on top.

const person = { email: "e2e-rail-order@example.test", password: "e2e-rail-order-password" };
const idSchema = z.object({ id: z.string() });
const projectSchema = z.object({ id: z.string(), name: z.string() });

async function signIn(page: Page): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

async function publishApp(page: Page, workspaceId: string, title: string): Promise<string> {
  const id = `rail-${randomUUID().slice(0, 8)}`;
  const path = `${apiOrigin}/api/v1/assets/app/${id}`;
  const saved = await requestWithOrigin(page, "put", path, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        { path: "app.yaml", text: `id: ${id}\nname: ${title}\nkit: 1.2.0\nentry: index.html\n` },
        {
          path: "index.html",
          text: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`
        }
      ]
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await requestWithOrigin(page, "post", `${path}/publish`, {
    data: { revision: 1, workspaceId, audience: "workspace" }
  });
  expect(published.ok(), await published.text()).toBe(true);
  return id;
}

async function createProject(page: Page, workspaceId: string, title: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/projects`, {
    data: { collaborationWorkspaceId: workspaceId, title, audience: "workspace" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return projectSchema.parse(await created.json()).name;
}

/** The names of the rows, top to bottom: each row carries its whole name as its title. */
async function titlesIn(rows: Locator): Promise<string[]> {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("title") ?? "")
  );
}

test("the Apps and the projects in the rail keep their alphabetical order when one is opened", async ({
  page,
  pageErrors: _pageErrors
}) => {
  test.setTimeout(120_000);
  const suffix = String(Date.now()).slice(-7);
  // Made in this order, so the newest is the first of the alphabet's end.
  const titles = ["Zebra", "Mitte", "Anfang"].map((name) => `${name} ${suffix}`);
  const alphabetical = [...titles].reverse();
  const [first = "", middle = "", last = ""] = alphabetical;
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: `Reihenfolge ${suffix}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const appIds = new Map<string, string>();
  const projectNames = new Map<string, string>();
  for (const title of titles) {
    appIds.set(title, await publishApp(page, workspaceId, title));
    projectNames.set(title, await createProject(page, workspaceId, title));
  }

  await page.goto(`/w/${workspaceId}`);
  const rail = page.getByRole("navigation", { name: /^(?:Main navigation|Hauptnavigation)$/u });
  await rail.getByTestId("rail-apps-toggle").click();
  const apps = rail.getByTestId("rail-apps").getByRole("button");
  const projects = rail.getByTestId("rail-projects").getByTestId("rail-project");
  await expect(apps).toHaveCount(3);
  await expect(projects).toHaveCount(3);
  expect(await titlesIn(apps)).toEqual(alphabetical);
  expect(await titlesIn(projects)).toEqual(alphabetical);

  // Open the second App, then the last and the first: the rail stands as it did.
  for (const title of [middle, last, first]) {
    const app = apps.filter({ hasText: title });
    await app.click();
    await expect(page).toHaveURL(new RegExp(`/apps/${appIds.get(title) ?? ""}$`, "u"));
    await expect(app).toHaveAttribute("aria-current", "true");
    expect(await titlesIn(apps)).toEqual(alphabetical);
  }
  // A reload reads what the browser kept of the opens, and the order is the same.
  await page.reload();
  await expect(apps).toHaveCount(3);
  expect(await titlesIn(apps)).toEqual(alphabetical);

  // The same for the projects.
  for (const title of [middle, last, first]) {
    const project = projects.filter({ hasText: title });
    await project.click();
    await expect(page).toHaveURL(new RegExp(`/p/${projectNames.get(title) ?? ""}$`, "u"));
    await expect(project).toHaveAttribute("aria-current", "true");
    expect(await titlesIn(projects)).toEqual(alphabetical);
  }
});
