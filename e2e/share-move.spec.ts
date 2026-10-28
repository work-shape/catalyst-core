import { randomUUID } from "node:crypto";
import { apiBaseUrl, reviewer, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import {
  allowBuilding,
  allowInOwnWorkspace,
  asker,
  builder,
  DESKTOP,
  expectOwner,
  idSchema,
  json,
  memberPage,
  openShare,
  ownSkill,
  PHONE,
  pickerSetup,
  shareFromHead,
  shoot,
  skillPicker
} from "./share-move-fixtures";

const shotsDir = process.env.E2E_SHOTS_DIR;
test.describe.configure({ retries: 0 });

test("a member shares a skill with their team and sees its new place", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  accessState: _accessState
}) => {
  test.setTimeout(shotsDir ? 240_000 : 120_000);
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  await signIn(page, reviewer);
  // The instance knows a person once they signed in: only then can they join a team.
  const builderPage = await memberPage(browser, baseURL, pageErrors, builder);
  const team = `Vertrieb ${tag}`;
  const teamId = idSchema.parse(await json(page, "post", "/api/v1/workspaces", { name: team })).id;
  await json(page, "post", `/api/v1/workspaces/${teamId}/members`, { email: builder.email });

  // The builder may build in their own workspace and in the team: sharing goes at once.
  const mineName = `share_move_mine_${tag}`;
  const mineTitle = `Angebotsprüfung ${tag}`;
  const builderOwn = await ownSkill(builderPage, mineName, mineTitle);
  await allowInOwnWorkspace(builderOwn.me, builderOwn.personal);
  await allowBuilding(page, builderOwn.me, teamId);
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
  await expectOwner(builderPage, "skill", mineName, teamId);

  // Keep the #164 regression: belonging to a team offers it even without building rights.
  const askerPage = await memberPage(browser, baseURL, pageErrors, asker);
  await json(page, "post", `/api/v1/workspaces/${teamId}/members`, { email: asker.email });
  const own = await ownSkill(askerPage, `share_team_ask_${tag}`, `Wochenbericht ${tag}`);
  await allowInOwnWorkspace(own.me, own.personal);
  await own.put();
  const ask = await openShare(
    askerPage,
    own.personal,
    `share_team_ask_${tag}`,
    `Wochenbericht ${tag}`
  );
  await ask.getByRole("radio", { name: new RegExp(team, "u") }).check();
  await expect(ask.locator("[data-share-users]")).toHaveText(`Die Mitglieder von ${team}`);
  await expect(ask.locator("[data-share-request]")).toBeVisible();
  await expect(ask.getByRole("button", { name: "Anfrage senden" })).toBeEnabled();
  await ask.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expectOwner(askerPage, "skill", `share_team_ask_${tag}`, own.personal);
  await askerPage.context().close();
  await builderPage.context().close();
});

for (const viewport of [DESKTOP, PHONE]) {
  test(`a greyed skill shares with everyone from the picker at ${viewport.width}px`, async ({
    page,
    instanceAgentsChange: _instanceAgentsChange
  }) => {
    test.setTimeout(90_000);
    await signIn(page, reviewer);
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    const fixture = await pickerSetup(page, page, randomUUID().replaceAll("-", "").slice(0, 8));
    try {
      const greyed = await skillPicker(page, fixture.agent, fixture.name, fixture.title);
      await expect(greyed).toHaveAttribute("data-picker-action", "");
      await expect(greyed).toContainText("Gehört nur dir.");
      await expect(greyed).toContainText("Für alle teilen…");
      await greyed.click();
      const dialog = page.getByRole("dialog", { name: `„${fixture.title}“ teilen` });
      await expect(dialog.locator("[data-share-users]")).toHaveText(
        "Alle, denen es angeboten wird"
      );
      await dialog.getByRole("button", { name: "Teilen", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expectOwner(page, "skill", fixture.name);
      const usable = await skillPicker(page, fixture.agent, fixture.name, fixture.title);
      await expect(usable).not.toHaveAttribute("data-picker-action");
      await expect(usable).not.toContainText("Für alle teilen…");
      await usable.click();
      await page.keyboard.press("Escape");
      await expect(
        page
          .getByRole("list", { name: "Skills", exact: true })
          .getByText(fixture.title, { exact: true })
      ).toBeVisible();
      await page.goto(`/build/skills/${fixture.name}`);
      await expect(
        page.locator("[data-asset-place]").getByText("Alle", { exact: true })
      ).toBeVisible();
    } finally {
      await fixture.cleanup();
    }
  });

  for (const kind of ["workflow", "app"] as const) {
    test(`the ${kind} page shares to a team and reopens there at ${viewport.width}px`, async ({
      page,
      browser,
      baseURL,
      pageErrors,
      accessState: _accessState
    }) => {
      test.setTimeout(120_000);
      await signIn(page, reviewer);
      const member = await memberPage(browser, baseURL, pageErrors, builder, viewport);
      try {
        const tag = randomUUID().replaceAll("-", "").slice(0, 8);
        const name = `share-${kind}-${tag}`;
        const title = `${kind === "app" ? "Umsatzübersicht" : "Angebotsprüfung"} ${tag}`;
        const personal = idSchema.parse(
          await json(member, "post", "/api/v1/workspaces/personal")
        ).id;
        const me = idSchema.parse(await json(member, "get", "/api/v1/me")).id;
        const team = `Vertrieb ${tag}`;
        const teamId = idSchema.parse(
          await json(page, "post", "/api/v1/workspaces", { name: team })
        ).id;
        await json(page, "post", `/api/v1/workspaces/${teamId}/members`, { email: builder.email });
        await allowInOwnWorkspace(me, personal, kind);
        await allowBuilding(page, me, teamId, kind);
        const assetPath = `/api/v1/assets/${kind}/${name}`;
        const made = await requestWithOrigin(member, "put", `${apiBaseUrl}${assetPath}`, {
          data: {
            workspaceId: personal,
            expectedRevision: null,
            ...(kind === "workflow"
              ? {
                  config: {
                    name,
                    manifest: {
                      id: name,
                      name: title,
                      description: "Prüft ein Angebot.",
                      inputs: { type: "object" },
                      outputs: { type: "object" },
                      steps: [
                        {
                          id: "start",
                          name: "Start",
                          type: "trigger",
                          triggers: [{ kind: "manual" }]
                        },
                        { id: "result", name: "Ergebnis", type: "output", input: {} }
                      ]
                    }
                  }
                }
              : {
                  files: [
                    {
                      path: "app.yaml",
                      text: `id: ${name}\nname: ${title}\nkit: 1.2.0\nentry: index.html\n`
                    },
                    {
                      path: "index.html",
                      text: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`
                    }
                  ]
                })
          }
        });
        expect(made.ok(), await made.text()).toBe(true);
        if (kind === "app") {
          // Publishing is setup; the member's actual sharing click is the behaviour under test.
          await json(page, "post", `${assetPath}/publish`, {
            workspaceId: personal,
            revision: 1,
            audience: "workspace"
          });
        }
        const section = kind === "app" ? "apps" : "workflows";
        await member.goto(`/w/${personal}/${section}/${name}`);
        const dialog = await shareFromHead(member, title);
        const teamChoice = dialog.getByRole("radio", { name: new RegExp(team, "u") });
        if (await teamChoice.count()) await teamChoice.check();
        else await expect(dialog.locator("[data-share-target]")).toHaveText(team);
        if (kind === "app") {
          // An App can move only into a team, never to Everyone.
          await expect(dialog.getByRole("radio", { name: /^Alle/u })).toHaveCount(0);
        }
        await expect(dialog.locator("[data-share-users]")).toHaveText(`Die Mitglieder von ${team}`);
        await expect(dialog.locator("[data-share-moves]")).toContainText(title);
        await expect(dialog.locator("[data-share-editors]")).toContainText("Du auch.");
        await expect(dialog.getByRole("button", { name: "Teilen", exact: true })).toBeEnabled();
        await shoot(member, `${kind}-dialog-${viewport.width}`);
        const [opened] = await Promise.all([
          member.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === "GET" &&
              url.pathname === assetPath &&
              url.searchParams.get("workspaceId") === teamId
            );
          }),
          dialog.getByRole("button", { name: "Teilen", exact: true }).click()
        ]);
        expect(opened.status()).toBe(200);
        await expect(dialog).toHaveCount(0);
        await expect(member).toHaveURL(new RegExp(`/w/${teamId}/${section}/${name}$`, "u"));
        await expect(member.getByRole("heading", { name: title, exact: true })).toBeVisible();
        await expectOwner(member, kind, name, teamId);
        await member.reload();
        await expect(member.getByRole("heading", { name: title, exact: true })).toBeVisible();
        if (kind === "app") {
          await expect(
            member
              .getByTestId("app-view")
              .getByTestId("page-preview-frame")
              .contentFrame()
              .frameLocator("iframe")
              .getByRole("heading", { name: title })
          ).toBeVisible();
        }
        await shoot(member, `${kind}-moved-${viewport.width}`);
      } finally {
        await member.context().close();
      }
    });
  }
}
