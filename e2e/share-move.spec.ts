import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { apiBaseUrl, reviewer, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// SHARE-1 "Teilen mit…": a member shares a skill of their own with their team at once; another
// may not share with everyone, so the same dialog sends a request, and an admin accepts it in
// the Inbox. The people are in `tests/fixtures/e2e-users/share-move.yaml`.

const builder = {
  email: "e2e-share-move-builder@example.test",
  password: "e2e-share-move-builder-password"
};
const asker = {
  email: "e2e-share-move-asker@example.test",
  password: "e2e-share-move-asker-password"
};
const shotsDir = process.env.E2E_SHOTS_DIR;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const idSchema = z.object({ id: z.string() });
const assetSchema = z.object({
  scope: z.union([
    z.object({ kind: z.literal("instance") }),
    z.object({ kind: z.literal("workspace"), workspaceId: z.string() })
  ])
});

/** The picture at phone and desktop width, in German, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize() ?? DESKTOP;
  for (const viewport of [PHONE, DESKTOP]) {
    await page.setViewportSize(viewport);
    await page.screenshot({
      path: join(shotsDir, `share-${name}-de-${viewport.width}.png`),
      animations: "disabled"
    });
  }
  await page.setViewportSize(size);
}

async function json(page: Page, method: "get" | "post", path: string, data?: unknown) {
  const response =
    method === "get"
      ? await page.request.get(`${apiBaseUrl}${path}`)
      : await requestWithOrigin(page, method, `${apiBaseUrl}${path}`, {
          ...(data === undefined ? {} : { data })
        });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as unknown;
}

/** A member signed in on a page of their own, in German. */
async function memberPage(
  browser: Browser,
  baseURL: string | undefined,
  pageErrors: PageErrorWatch,
  member: { email: string; password: string }
): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: DESKTOP });
  await pageErrors.watch(context);
  const page = await context.newPage();
  await signIn(page, member);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  return page;
}

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

/**
 * Lets a person build skills in their own workspace, as a row the instance's admin could not
 * write through the grants operation, which names Shared Workspaces only.
 */
async function allowInOwnWorkspace(holderId: string, workspaceId: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const action of ["skill.read", "skill.write"]) {
      await sql`
        insert into permission_grants
          (id, client_instance_id, holder_kind, holder_id, action, scope_kind, scope_id, effect,
           granted_by)
        values
          (${`grant_e2e_share_${action}_${holderId}`}, 'demo-e2e', 'user', ${holderId}, ${action},
           'workspace', ${workspaceId}, 'allow', 'e2e')
        on conflict (id) do nothing`;
    }
  } finally {
    await sql.end();
  }
}

/** The admin gives a person a right on the skills of one team. */
async function allowSkills(admin: Page, holderId: string, workspaceId: string): Promise<void> {
  for (const action of ["skill.read", "skill.write"]) {
    await json(admin, "post", "/api/v1/instance/access/grants", {
      holderKind: "user",
      holderId,
      action,
      scopeKind: "workspace",
      scopeId: workspaceId
    });
  }
}

/** The member's own workspace, their id, and a skill of theirs in it. */
async function ownSkill(page: Page, name: string, title: string) {
  const personal = idSchema.parse(await json(page, "post", "/api/v1/workspaces/personal")).id;
  const me = idSchema.parse(await json(page, "get", "/api/v1/me")).id;
  return {
    personal,
    me,
    put: async () => {
      const made = await requestWithOrigin(
        page,
        "put",
        `${apiBaseUrl}/api/v1/assets/skill/${name}`,
        {
          data: {
            workspaceId: personal,
            expectedRevision: null,
            config: { name, title, description: "Meine Schritte.", content: `# ${title}\n` }
          }
        }
      );
      expect(made.ok(), await made.text()).toBe(true);
    }
  };
}

/** Opens the skill's page in the member's own workspace and its "Teilen…". */
async function openShare(page: Page, personal: string, name: string, title: string) {
  await page.evaluate(
    (id) => window.localStorage.setItem("vivd-catalyst:build-scope", id),
    personal
  );
  await page.goto(`/build/skills/${name}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(
    page.locator("[data-asset-place]").getByText("Nur ich", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Weitere Aktionen" }).first().click();
  await page.getByRole("menuitem", { name: "Teilen…" }).click();
  const dialog = page.getByRole("dialog", { name: `„${title}“ teilen` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a member shares a skill with their team, another asks to share with everyone, an admin accepts", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(shotsDir ? 240_000 : 120_000);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  await signIn(page, reviewer);
  // The instance knows a person once they signed in: only then can they join a team.
  const builderPage = await memberPage(browser, baseURL, pageErrors, builder);
  const askerPage = await memberPage(browser, baseURL, pageErrors, asker);
  const team = `Vertrieb ${tag}`;
  const teamId = idSchema.parse(await json(page, "post", "/api/v1/workspaces", { name: team })).id;
  await json(page, "post", `/api/v1/workspaces/${teamId}/members`, { email: builder.email });
  await json(page, "post", `/api/v1/workspaces/${teamId}/members`, { email: asker.email });

  // The builder may build in their own workspace and in the team: sharing goes at once.
  const mineName = `share_move_mine_${tag}`;
  const mineTitle = `Angebotsprüfung ${tag}`;
  const builderOwn = await ownSkill(builderPage, mineName, mineTitle);
  await allowInOwnWorkspace(builderOwn.me, builderOwn.personal);
  await allowSkills(page, builderOwn.me, teamId);
  await builderOwn.put();

  const direct = await openShare(builderPage, builderOwn.personal, mineName, mineTitle);
  await direct.getByRole("radio", { name: new RegExp(team, "u") }).check();
  await expect(direct.locator("[data-share-users]")).toHaveText(`Die Mitglieder von ${team}`);
  await expect(direct.locator("[data-share-editors]")).toContainText("Du auch.");
  await expect(direct.locator("[data-share-moves]")).toContainText(mineTitle);
  const share = direct.getByRole("button", { name: "Teilen", exact: true });
  await expect(share).toBeEnabled();
  await shoot(builderPage, "dialog-direct");
  await share.click();
  await expect(direct).toHaveCount(0);
  // The page now says where the skill sits: with the team.
  await expect(builderPage.locator("[data-asset-place]")).toContainText(team);
  await shoot(builderPage, "moved-team");
  const moved = assetSchema.parse(
    await json(builderPage, "get", `/api/v1/assets/skill/${mineName}?workspaceId=${teamId}`)
  );
  expect(moved.scope).toEqual({ kind: "workspace", workspaceId: teamId });

  // The asker builds in their own workspace only: sharing with everyone sends a request.
  const askName = `share_move_ask_${tag}`;
  const askTitle = `Wochenbericht ${tag}`;
  const askerOwn = await ownSkill(askerPage, askName, askTitle);
  await allowInOwnWorkspace(askerOwn.me, askerOwn.personal);
  await askerOwn.put();

  const ask = await openShare(askerPage, askerOwn.personal, askName, askTitle);
  // The team gives the asker no right on its skills, yet they belong to it: it is offered first,
  // as a request, and Alle beside it.
  const toTeam = ask.getByRole("radio", { name: new RegExp(team, "u") });
  await expect(toTeam).toBeChecked();
  await expect(ask.locator("[data-share-users]")).toHaveText(`Die Mitglieder von ${team}`);
  await expect(ask.locator("[data-share-request]")).toBeVisible();
  await expect(ask.getByRole("button", { name: "Anfrage senden" })).toBeEnabled();
  await shoot(askerPage, "dialog-request-team");
  await ask.getByRole("radio", { name: /^Alle/u }).check();
  await expect(ask.locator("[data-share-users]")).toHaveText("Alle, denen es angeboten wird");
  await expect(ask.locator("[data-share-request]")).toBeVisible();
  const send = ask.getByRole("button", { name: "Anfrage senden" });
  await expect(send).toBeEnabled();
  await shoot(askerPage, "dialog-request");
  await send.click();
  await expect(ask.locator("[data-share-requested]")).toBeVisible();
  await shoot(askerPage, "requested");
  await ask.getByRole("button", { name: "Schließen" }).last().click();

  // The admin finds the request in the Inbox: who asks to share what with whom, what the move
  // does, and Annehmen.
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.setViewportSize(DESKTOP);
  await page.goto("/inbox");
  const heading = `E2E Zz Move Asker möchte „${askTitle}“ für alle teilen`;
  const row = page.getByTestId("inbox-row").filter({ hasText: askTitle });
  await expect(row).toHaveCount(1);
  await row.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/inbox\/[^/]+$/u);
  await expect(page.getByText(heading).first()).toBeVisible();
  const body = page.locator("[data-asset-move]");
  await expect(body.locator("[data-share-users]")).toHaveText("Alle, denen es angeboten wird");
  await shoot(page, "inbox-request");
  await page.getByRole("button", { name: "Annehmen" }).click();
  await expect(page.getByRole("button", { name: "Annehmen" })).toHaveCount(0);

  const shared = assetSchema.parse(await json(page, "get", `/api/v1/assets/skill/${askName}`));
  expect(shared.scope).toEqual({ kind: "instance" });

  await builderPage.context().close();
  await askerPage.context().close();
});
