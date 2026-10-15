import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  plantGuardrailHits,
  plantReleaseAsset,
  removeConnection as removeReleaseAsset,
  removeGuardrailHits
} from "./connection-fixtures";
import { z } from "zod";
import { shoot } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Studio > Guardrails on the instance's own answers: the list, which says of each Guardrail in
// one line when it runs, and the page of one Guardrail with its newest hits. Two Guardrails
// are planted in the store as the release seed writes them; the suite's release config names
// none, so nothing else checks with them. A third is written and published as an asset whose
// filter narrows it to one workspace, which its line names.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** Set to a directory to keep pictures of the list and the page. */
const shotsDir = process.env.E2E_SHOTS_DIR;

async function setView(
  page: Page,
  view: { locale?: "en" | "de"; theme?: "light" | "dark" }
): Promise<void> {
  await page.evaluate(({ locale, theme }) => {
    for (const [key, value] of [
      ["vivd-catalyst:locale", locale],
      ["vivd-catalyst:theme", theme]
    ] as const) {
      if (value === undefined) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    }
  }, view);
}

function guardrail(name: string, displayName: string, outcome: "warn" | "block", kind?: string) {
  return {
    id: `cfga_${randomUUID()}`,
    kind: "guardrail",
    name,
    displayName,
    config: {
      name,
      displayName,
      description: "A fixture of the browser suite.",
      on: "approval_request.before_create",
      ...(kind ? { filter: { kind } } : {}),
      check: {
        kind: "model_judge",
        modelBindingId: "fixture",
        instruction:
          "Check whether the text names a customer, a case or a person.\nGeneral rules are allowed."
      },
      outcome,
      origin: "release"
    }
  };
}

// The Guardrails are of origin `release` and no release config names them, so an API process
// that starts meanwhile deletes them: the test takes the turn of the specs that start one.
test("Studio lists the Guardrails with when each runs, and a Guardrail's page shows its newest hits", async ({
  page,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(shotsDir ? 240_000 : 90_000);
  const suffix = randomUUID().slice(0, 8);
  const privacy = guardrail(
    `e2e_privacy_${suffix}`,
    "No personal data in skills",
    "block",
    "skill_change"
  );
  const tone = guardrail(`e2e_tone_${suffix}`, "Polite tone", "warn");

  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = page.getByRole("region", { name: "Studio" });
  const workspaceName = `Kai Spezis ${suffix}`;
  const assetGuardrail = `e2e_kai_iban_${suffix}`;
  let assetGuardrailId: string | undefined;

  const shoot = async (name: string, ready: () => Promise<void>) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    for (const [width, height, locale, theme] of [
      [1280, 800, "en", "light"],
      [1280, 800, "en", "dark"],
      [1280, 800, "de", "light"],
      [390, 844, "de", "light"],
      [390, 844, "de", "dark"]
    ] as const) {
      await page.setViewportSize({ width, height });
      await setView(page, { locale, theme });
      await page.reload();
      await ready();
      await page.screenshot({ path: join(shotsDir, `${name}-${theme}-${locale}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await setView(page, {});
    await page.reload();
    await ready();
  };

  try {
    await plantReleaseAsset(privacy);
    await plantReleaseAsset(tone);
    // A guardrail written and published as an asset, narrowed to one workspace.
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: workspaceName }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;
    const guardrailUrl = `${apiBaseUrl}/api/v1/assets/guardrail/${assetGuardrail}`;
    const written = await requestWithOrigin(page, "put", guardrailUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: assetGuardrail,
          displayName: "No IBAN in Kai Spezis",
          on: "asset.before_write",
          filter: { kind: "skill", origin: "agent", workspace: workspaceId },
          check: { kind: "pattern", pattern: "DE\\d{20}", reason: "Skills hold no IBAN." },
          outcome: "block"
        }
      }
    });
    expect(written.status(), await written.text()).toBe(200);
    const published = await requestWithOrigin(page, "post", `${guardrailUrl}/publish`, {
      data: { revision: 1 }
    });
    expect(published.status(), await published.text()).toBe(200);
    assetGuardrailId = z
      .object({ id: z.string() })
      .parse(await (await page.request.get(guardrailUrl)).json()).id;
    await plantGuardrailHits(privacy.name, [
      {
        outcome: "block",
        message: "The text names a customer and a file number.",
        kind: "skill_change"
      },
      {
        outcome: "block",
        message: "The text contains an IBAN.",
        kind: "skill_change"
      },
      { outcome: "warn", message: "", kind: "skill_change" }
    ]);

    await test.step("the list says what each Guardrail does and offers nothing to create", async () => {
      await page.goto("/build/guardrails");
      await expect(page.getByRole("heading", { name: "Guardrails", level: 1 })).toBeVisible();
      await expect(
        page
          .getByRole("navigation", { name: "Kinds in Studio" })
          .getByRole("button", { name: "Guardrails", exact: true })
      ).toHaveAttribute("aria-current", "true");
      const privacyRow = main.locator(`a[href="/build/guardrails/${privacy.name}"]`);
      const toneRow = main.locator(`a[href="/build/guardrails/${tone.name}"]`);
      await expect(privacyRow).toContainText("No personal data in skills");
      await expect(privacyRow).toContainText("Blocks");
      // Each row says when the guardrail runs, in words.
      await expect(privacyRow).toContainText(
        "Runs before anyone asks for an approval of the kind Skill change, instance-wide, set by the operator."
      );
      const assetRow = main.locator(`a[href="/build/guardrails/${assetGuardrail}"]`);
      await expect(assetRow).toContainText(
        `Runs before an agent saves a skill, in workspace ${workspaceName}. Checks the content for a text pattern. Blocks if the check fails.`
      );
      await expect(toneRow).toContainText("Warns");
      await expect(main.getByRole("button", { name: /^New /u })).toHaveCount(0);
      await shoot("guardrails-list", async () => {
        await expect(privacyRow).toBeVisible();
      });
    });

    await test.step("a Guardrail's page counts its hits and lists them newest first, naming nobody", async () => {
      await page.goto(`/build/guardrails/${privacy.name}`);
      await expect(
        page.getByRole("heading", { name: "No personal data in skills", level: 1 })
      ).toBeVisible();
      await expect(
        main.getByText(
          "Runs before anyone asks for an approval of the kind Skill change, instance-wide, set by the operator.",
          { exact: false }
        )
      ).toBeVisible();
      const hits = main.locator("[data-guardrail-hit]");
      await expect(hits).toHaveCount(3);
      await expect(hits.first()).toContainText("The text names a customer and a file number.");
      await expect(hits.nth(2)).toContainText("The check could not be run.");
      // A hit says on what kind of request, not who asked.
      await expect(hits.first()).toContainText("Skill change");
      const counts = main.locator("[data-guardrail-hit-counts]");
      await expect(counts).toContainText("Last 7 days");
      await expect(counts).toContainText("Last 30 days");
      await expect(counts.locator("dd")).toHaveText(["3", "3"]);
      await expect(main.getByRole("button", { name: /Save/u })).toHaveCount(0);
      await shoot("guardrail-page", async () => {
        await expect(main.locator("[data-guardrail-hit]")).toHaveCount(3);
      });
    });

    await test.step("a Guardrail without hits says so", async () => {
      await page.goto(`/build/guardrails/${tone.name}`);
      await expect(page.getByRole("heading", { name: "Polite tone", level: 1 })).toBeVisible();
      await expect(main.getByText(/^No hits yet\./u)).toBeVisible();
      await expect(main.getByText("Everything at this point")).toBeVisible();
      await shoot("guardrail-page-empty", async () => {
        await expect(main.getByText(/^(No hits yet|Noch keine Treffer)\./u)).toBeVisible();
      });
    });
  } finally {
    if (assetGuardrailId) await removeReleaseAsset(assetGuardrailId);
    await removeGuardrailHits(privacy.name);
    await removeReleaseAsset(privacy.id);
    await removeReleaseAsset(tone.id);
  }
});

// GR-PUB-1: the guardrail the platform ships is the first row of the list, under its search and
// scope, on, with its switch for an instance admin. Switching it off asks first. The test cancels: every spec file runs against
// the same instance, and the switch is the instance's. Switching itself is held by the server
// tests (`tests/publish-approval-guardrail.test.ts`).
test("Studio shows the guardrail the platform ships, on, and asks before it is switched off", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 180_000 : 60_000);
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/build/guardrails");
  const list = page.getByRole("list", { name: "Guardrails", exact: true });
  const shipped = list
    .getByRole("listitem")
    .filter({ hasText: "Publishing needs an instance admin's approval" });
  await expect(shipped).toContainText("Shipped with the platform");
  await expect(shipped).toContainText("Needs approval");
  await expect(shipped).toContainText("On, as the platform ships it.");
  // It is a row of the one list, which stands under the search, and the list is not empty.
  await expect(list.getByRole("listitem").first()).toContainText(
    "Publishing needs an instance admin's approval"
  );
  const search = page.getByRole("searchbox", { name: "Search guardrails" });
  const searchBox = await search.boundingBox();
  const rowBox = await shipped.boundingBox();
  expect(searchBox && rowBox && searchBox.y < rowBox.y).toBe(true);
  await expect(page.getByText(/^Nothing in .* yet\.$/u)).toHaveCount(0);
  // The search narrows it as it narrows every row.
  await search.fill("no guardrail is called this");
  await expect(shipped).toHaveCount(0);
  await search.fill("publishing");
  await expect(shipped).toBeVisible();
  await search.fill("");
  const toggle = shipped.getByRole("switch");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeEnabled();
  await shoot(page, "gr-pub-1-guardrails-switch", async () => {
    await expect(page.getByRole("switch").first()).toHaveAttribute("aria-checked", "true");
  });

  await toggle.click();
  const asked = page.getByRole("dialog", {
    name: "Switch off “Publishing needs an instance admin's approval”?"
  });
  await expect(asked).toContainText("no admin is asked");
  await shoot(page, "gr-pub-1-guardrails-switch-off", async () => {
    await page.getByRole("switch").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});
