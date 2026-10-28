import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { apiBaseUrl, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, type PageErrorWatch } from "./test";

// People and setup shared by the direct sharing and Inbox browser journeys.
// The people are in `tests/fixtures/e2e-users/share-move.yaml`.

export const builder = {
  email: "e2e-share-move-builder@example.test",
  password: "e2e-share-move-builder-password"
};
export const asker = {
  email: "e2e-share-move-asker@example.test",
  password: "e2e-share-move-asker-password"
};
const shotsDir = process.env.E2E_SHOTS_DIR;
export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 900 };
export const idSchema = z.object({ id: z.string() });
const assetSchema = z.object({
  scope: z.union([
    z.object({ kind: z.literal("instance") }),
    z.object({ kind: z.literal("workspace"), workspaceId: z.string() })
  ])
});

/** The picture at phone and desktop width, in German, where `E2E_SHOTS_DIR` names a folder. */
export async function shoot(page: Page, name: string): Promise<void> {
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

export async function json(page: Page, method: "get" | "post", path: string, data?: unknown) {
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
export async function memberPage(
  browser: Browser,
  baseURL: string | undefined,
  pageErrors: PageErrorWatch,
  member: { email: string; password: string },
  viewport = DESKTOP
): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: DESKTOP });
  await pageErrors.watch(context);
  const page = await context.newPage();
  await signIn(page, member);
  await page.setViewportSize(viewport);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  return page;
}

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;

/**
 * Lets a person build this kind in their own workspace, as a row the instance's admin could not
 * write through the grants operation, which names Shared Workspaces only.
 */
export async function allowInOwnWorkspace(
  holderId: string,
  workspaceId: string,
  kind = "skill"
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const action of [`${kind}.read`, `${kind}.write`]) {
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

/** The admin gives a person building rights on one kind in one team. */
export async function allowBuilding(
  admin: Page,
  holderId: string,
  workspaceId: string,
  kind = "skill"
): Promise<void> {
  for (const action of [`${kind}.read`, `${kind}.write`]) {
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
export async function ownSkill(page: Page, name: string, title: string) {
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
export async function openShare(page: Page, personal: string, name: string, title: string) {
  await page.evaluate(
    (id) => window.localStorage.setItem("vivd-catalyst:build-scope", id),
    personal
  );
  await page.goto(`/build/skills/${name}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(
    page.locator("[data-asset-place]").getByText("Nur ich", { exact: true })
  ).toBeVisible();
  return shareFromHead(page, title);
}

/** Open the page head's sharing menu after the asset has loaded. */
export async function shareFromHead(page: Page, title: string) {
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Weitere Aktionen" }).first().click();
  await page.getByRole("menuitem", { name: "Teilen…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `„${title}“ teilen` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Read the stored owner as this person, rather than trusting a changed address alone. */
export async function expectOwner(page: Page, kind: string, name: string, workspaceId?: string) {
  const query = workspaceId ? `?workspaceId=${workspaceId}` : "";
  const asset = assetSchema.parse(
    await json(page, "get", `/api/v1/assets/${kind}/${name}${query}`)
  );
  expect(asset.scope).toEqual(
    workspaceId ? { kind: "workspace", workspaceId } : { kind: "instance" }
  );
}

/** The agent's real chooser, narrowed to this test's skill. */
export async function skillPicker(page: Page, agent: string, skill: string, title: string) {
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:build-scope", "instance"));
  await page.goto(`/build/agents/${agent}`);
  await page.getByRole("button", { name: "Skills: Skills auswählen", exact: true }).click();
  await page.getByRole("combobox", { name: "Suchen", exact: true }).fill(skill);
  const option = page
    .getByRole("listbox", { name: "Skills auswählen" })
    .getByRole("option")
    .filter({ hasText: title });
  await expect(option).toBeVisible();
  return option;
}

/** A private skill and an agent for everyone; only this agent is editable by the requester. */
export async function pickerSetup(admin: Page, member: Page, tag: string) {
  const name = `share_picker_skill_${tag}`;
  const title = `Steuerprüfung ${tag}`;
  const own = await ownSkill(member, name, title);
  await allowInOwnWorkspace(own.me, own.personal);
  await own.put();
  const agent = `share_picker_agent_${tag}`;
  const made = await requestWithOrigin(admin, "put", `${apiBaseUrl}/api/v1/assets/agent/${agent}`, {
    data: {
      expectedRevision: null,
      config: {
        name: agent,
        displayName: `Prüfer ${tag}`,
        description: "Prüft Angebote.",
        instructions: "Prüfe Angebote."
      }
    }
  });
  expect(made.ok(), await made.text()).toBe(true);
  const record = idSchema.parse(await json(admin, "get", `/api/v1/assets/agent/${agent}`));
  const grants: string[] = [];
  const adminId = idSchema.parse(await json(admin, "get", "/api/v1/me")).id;
  for (const action of adminId === own.me ? [] : ["agent.read", "agent.write"]) {
    grants.push(
      idSchema.parse(
        await json(admin, "post", "/api/v1/instance/access/grants", {
          holderKind: "user",
          holderId: own.me,
          action,
          scopeKind: "asset",
          scopeId: record.id
        })
      ).id
    );
  }
  return {
    name,
    title,
    agent,
    personal: own.personal,
    cleanup: async () => {
      for (const id of grants) {
        const removed = await requestWithOrigin(
          admin,
          "delete",
          `${apiBaseUrl}/api/v1/instance/access/grants/${id}`
        );
        expect(removed.ok(), await removed.text()).toBe(true);
      }
      const asset = z
        .object({ revision: z.number() })
        .parse(await json(admin, "get", `/api/v1/assets/agent/${agent}`));
      const removed = await requestWithOrigin(
        admin,
        "post",
        `${apiBaseUrl}/api/v1/assets/agent/${agent}/delete`,
        {
          data: { expectedRevision: asset.revision }
        }
      );
      expect(removed.ok(), await removed.text()).toBe(true);
    }
  };
}
