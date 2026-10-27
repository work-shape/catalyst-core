import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect, type Page } from "@playwright/test";

/** A real App with historical API rows covering known and unknown save authors and dates. */
export async function openAppHistory({
  page,
  apiURL,
  baseURL,
  locale,
  open = true
}: {
  page: Page;
  apiURL: string;
  baseURL: string;
  locale: "en" | "de";
  open?: boolean;
}) {
  const headers = { Origin: baseURL };
  const workspace = await page.request.post(`${apiURL}/api/v1/workspaces`, {
    headers,
    data: { name: "Sales team" }
  });
  expect(workspace.ok()).toBe(true);
  const { id: workspaceId } = z.object({ id: z.string() }).parse(await workspace.json());
  const name = `history-${randomUUID().slice(0, 8)}`;
  const path = `/api/v1/assets/app/${name}`;
  const saved = await page.request.put(`${apiURL}${path}`, {
    headers,
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${name}\nname: Revenue board\nkit: 1.2.0\nentry: index.html\n`
        },
        {
          path: "index.html",
          text: "<!doctype html><html><head><title>Revenue board</title></head><body><h1>Revenue board</h1></body></html>"
        }
      ]
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await page.request.post(`${apiURL}${path}/publish`, {
    headers,
    data: { revision: 1, workspaceId, audience: "workspace" }
  });
  expect(published.ok(), await published.text()).toBe(true);
  const record = await page.request.get(`${apiURL}${path}?workspaceId=${workspaceId}`);
  const asset = z
    .object({ id: z.string(), config: z.record(z.string(), z.unknown()) })
    .parse(await record.json());
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          revision: 65,
          draftRevision: 65,
          publishedRevision: 1,
          liveVersion: { number: 1 },
          draftChangedSinceLive: true
        }
      });
    }
  );
  await page.route(
    (url) => url.pathname === `${path}/publications`,
    (route) =>
      route.fulfill({
        json: {
          items: [{ number: 1, revision: 1, actor: null }]
        }
      })
  );
  const revisions = Array.from({ length: 65 }, (_, index) => {
    const number = 65 - index;
    return {
      assetId: asset.id,
      revision: number,
      operation: number === 1 ? "create" : "update",
      config: asset.config,
      actor: { displayLabel: "Jana Petersen", roles: [] },
      globalVersion: number,
      createdAt: new Date(Date.UTC(2026, 9, 1, 9, number)).toISOString(),
      ...(number === 1
        ? {}
        : {
            origin:
              index === 1
                ? {
                    kind: "page",
                    conversationId: "history",
                    pageId: "preview",
                    fileSetNumber: 1,
                    byAgent: true,
                    agentDisplayName: "Page helper"
                  }
                : {
                    kind: "agent_run",
                    conversationId: "history",
                    ...(index % 3 === 0 ? { agentDisplayName: "Report assistant" } : {})
                  }
          })
    };
  });
  await page.route(
    (url) => url.pathname === `${path}/revisions`,
    (route) => route.fulfill({ json: { items: revisions } })
  );
  await page.goto(`${baseURL}/w/${workspaceId}/app-drafts/${name}`);
  const edit = page.getByTestId("app-edit");
  await expect(edit).toContainText(locale === "de" ? "Live: Version 1" : "Live: version 1");
  await expect(edit).not.toContainText(/· (?:since|seit) /u);
  const show = async () => {
    await edit
      .getByRole("button", { name: locale === "de" ? "Weitere Aktionen" : "More actions" })
      .click();
    await page.getByRole("menuitem", { name: locale === "de" ? "Verlauf" : "History" }).click();
  };
  if (open) await show();
  return {
    edit,
    show,
    drawer: page.getByRole("dialog", { name: locale === "de" ? "Verlauf" : "History" })
  };
}
