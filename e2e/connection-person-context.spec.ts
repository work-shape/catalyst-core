import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { layoutVariants } from "./layout-variants";
import { randomUUID } from "node:crypto";
import type { Locator, Route } from "@playwright/test";
import { z } from "zod";
import { ALLOWED_URL, removeServicePrincipal } from "./connection-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { requestAnswered } from "./allowed-page-errors";
const PERSON_CONTEXT_TEST =
  "person context mappings are chosen by name, saved, refused when stale and removed";

// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "person-context-save-that-is-stale",
        reason:
          "Chromium's own log line: the test saves a mapping from an outdated version, the " +
          "instance answers 409 and the test asserts that the page refuses the stale save.",
        matches: requestAnswered(409),
        path: /^\/api\/v1\/connections\/e2e-person-context-[0-9a-f]{8}\/person-context$/u,
        tests: [PERSON_CONTEXT_TEST]
      },
      {
        name: "person-context-read-that-fails",
        reason:
          "Chromium's own log line: the test answers the read of a Connection's person context " +
          "mappings with 500 and asserts that the page says so.",
        matches: requestAnswered(500),
        path: /^\/api\/v1\/connections\/e2e-person-context-[0-9a-f]{8}\/person-context$/u,
        tests: [PERSON_CONTEXT_TEST]
      },
      {
        name: "person-context-user-list-that-fails-or-is-refused",
        reason:
          "Chromium's own log line: the test replaces the list of the instance's users with a 500 " +
          "failure and a 403 refusal and asserts the page's failure and no-permission states.",
        matches: new RegExp(`${requestAnswered(500).source}|${requestAnswered(403).source}`, "u"),
        path: /^\/api\/v1\/instance\/users$/u,
        tests: [PERSON_CONTEXT_TEST]
      }
    ]
  }
});

// The person context mappings on the page of a REST API Connection (CS-15). A runtime http_api
// Connection that sends `X-Person-Ref` is created through `assets.put`; its address is the one
// the suite's `egress.allow` permits, and nothing is called. The admin chooses a person and a
// service principal by name, saves, meets a change made elsewhere, and removes the mapping.
// The read failing, the list failing and a reader who may not list people are shown with the
// instance's answer replaced on its way to the page. E2E_SHOTS_DIR enables attached pictures
// in light English at 1280 and 390, plus German at 390.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const HEADER = "X-Person-Ref";

type Locale = "en" | "de";
type SubjectKind = "user" | "service_principal";

const WORDS: Record<
  Locale,
  {
    principal: string;
    save: string;
    remove: string;
    conflict: string;
    listFailed: string;
    peopleHidden: string;
    enterId: string;
    tryAgain: string;
  }
> = {
  en: {
    principal: "Service principal",
    save: "Save mapping",
    remove: "Remove mapping",
    conflict: "Someone changed this mapping in the meantime.",
    listFailed: "The list could not be loaded.",
    peopleHidden: "Choosing a person by name needs the right to manage users.",
    enterId: "Enter a technical ID instead",
    tryAgain: "Try again"
  },
  de: {
    principal: "Technisches Konto",
    save: "Zuordnung speichern",
    remove: "Zuordnung entfernen",
    conflict: "Jemand hat diese Zuordnung inzwischen geändert.",
    listFailed: "Die Liste ließ sich nicht laden.",
    peopleHidden: "Um eine Person nach Namen auszuwählen",
    enterId: "Stattdessen eine technische ID eingeben",
    tryAgain: "Erneut versuchen"
  }
};

const mappingSchema = z.object({
  subjectKind: z.enum(["user", "service_principal"]),
  subjectId: z.string(),
  value: z.string().optional(),
  rowVersion: z.number().int().nullable()
});
const meSchema = z.object({ id: z.string(), displayLabel: z.string(), email: z.string() });
const principalSchema = z.object({ principal: z.object({ id: z.string() }) });

/** Answers a call with the suite's refusal, keeping the instance's headers. */
async function refuse(route: Route, status: 403 | 500): Promise<void> {
  const response = await route.fetch();
  const code = status === 403 ? "FORBIDDEN" : "INTERNAL";
  await route.fulfill({
    response,
    status,
    json: { error: { code, message: `The suite answered ${code}` } }
  });
}

const isPath = (path: string) => (url: URL) => url.pathname === path;

// The test creates a Connection and a service principal and writes mappings: it takes the
// Connection writers' turn, which takes the access turn first.
test("person context mappings are chosen by name, saved, refused when stale and removed", async ({
  page,
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(240_000);
  const name = `e2e-person-context-${randomUUID().slice(0, 8)}`;
  const principalName = `e2e-person-context-${randomUUID().slice(0, 8)}`;
  const assetUrl = `${apiBaseUrl}/api/v1/assets/connection/${name}`;
  const mappingUrl = `${apiBaseUrl}/api/v1/connections/${name}/person-context`;
  const mappingPath = new URL(mappingUrl).pathname;

  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const me = meSchema.parse(await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json());

  const readMapping = async (kind: SubjectKind, id: string) => {
    const response = await page.request.get(mappingUrl, {
      params: { subjectKind: kind, subjectId: id }
    });
    expect(response.ok(), await response.text()).toBe(true);
    return mappingSchema.parse(await response.json());
  };
  const writeMapping = async (
    kind: SubjectKind,
    id: string,
    value: string | null,
    expectedRowVersion: number | null
  ) => {
    const response = await requestWithOrigin(page, "put", mappingUrl, {
      data: { subjectKind: kind, subjectId: id, value, expectedRowVersion }
    });
    expect(response.status(), await response.text()).toBe(200);
    return mappingSchema.parse(await response.json());
  };

  const created = await requestWithOrigin(page, "put", assetUrl, {
    data: {
      expectedRevision: null,
      config: {
        name,
        displayName: "Person context records",
        connectorType: "http_api",
        settings: { baseUrl: ALLOWED_URL.replace(/\/$/u, ""), personContextHeader: HEADER },
        authScheme: "none",
        operations: []
      }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  let principalId: string | undefined;
  try {
    const principal = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/service-principals`,
      {
        data: {
          name: principalName,
          displayLabel: principalName,
          description: "Calls the records API in a spec."
        }
      }
    );
    expect(principal.ok(), await principal.text()).toBe(true);
    principalId = principalSchema.parse(await principal.json()).principal.id;

    // The admin's own mapping is there before the page is opened.
    const seeded = await writeMapping("user", me.id, "ref-seed-001", null);
    expect(seeded.value).toBe("ref-seed-001");
    expect(typeof seeded.rowVersion).toBe("number");

    const main = page.getByRole("region", { name: "Studio" });
    const section = main.locator("#person-context");
    const chooser = section.locator('[data-connection-field="personContextSubject"]');
    const mapping = section.locator("[data-person-context-mapping]");
    const valueField = section.locator('[data-connection-field="personContextValue"]');

    const open = async (view: { locale: Locale; theme: "light" | "dark"; width: 1280 | 390 }) => {
      await page.setViewportSize({ width: view.width, height: view.width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: view.theme });
      await page.goto(`/build/connections/${name}`);
      await page.evaluate(({ locale, theme }) => {
        window.localStorage.setItem("vivd-catalyst:locale", locale);
        window.localStorage.setItem("vivd-catalyst:theme", theme);
      }, view);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Person context records", level: 1 })
      ).toBeVisible();
      await expect(section).toContainText(HEADER);
    };
    const shoot = async (label: string, target: Locator = section) => {
      const shotsDir = process.env.E2E_SHOTS_DIR;
      if (!shotsDir) return;
      await mkdir(shotsDir, { recursive: true });
      await target.scrollIntoViewIfNeeded();
      const path = join(shotsDir, `evidence-person-context-${label}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await test.info().attach(`person-context-${label}`, { path, contentType: "image/png" });
    };
    const choose = async (option: { label: string; text: string }) => {
      await chooser.click();
      const listbox = page.getByRole("listbox");
      // Many people may be listed: the search narrows the list where it is offered.
      const search = page.locator("[cmdk-input]");
      if (await search.isVisible()) {
        await search.fill(option.text);
      }
      await listbox.getByRole("option").filter({ hasText: option.text }).first().click();
      await expect(chooser).toContainText(option.label);
    };
    const button = (label: string) => section.getByRole("button", { name: label, exact: true });

    for (const [theme, locale, width] of layoutVariants(1280)) {
      const words = WORDS[locale];
      await open({ locale, theme, width });
      // Nobody is chosen: the list offers names, and no technical ID field stands beside it.
      await expect(chooser).toBeVisible();
      await expect(section.locator('[data-connection-field="personContextSubjectId"]')).toHaveCount(
        0
      );
      await expect(mapping).toHaveCount(0);
      await shoot(`${locale}-${theme}-${width}-start`);

      // The admin's own mapping, chosen by name.
      await choose({ label: me.displayLabel, text: me.email });
      await expect(mapping).toHaveAttribute("data-person-context-mapping", "mapped");
      await expect(valueField).toHaveValue("ref-seed-001");
      await shoot(`${locale}-${theme}-${width}-person-mapped`);

      // The service principal, chosen by name: it has no mapping yet.
      await section.getByRole("radio", { name: words.principal }).click();
      await expect(mapping).toHaveCount(0);
      await choose({ label: principalName, text: principalName });
      await expect(mapping).toHaveAttribute("data-person-context-mapping", "unmapped");
      await shoot(`${locale}-${theme}-${width}-principal-unmapped`);

      // Switching back to the person shows their stored mapping again.
      await section.getByRole("radio").first().click();
      await choose({ label: me.displayLabel, text: me.email });
      await expect(mapping).toHaveAttribute("data-person-context-mapping", "mapped");
      await shoot(`${locale}-${theme}-${width}-person-restored`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }

    const words = WORDS.en;
    await open({ locale: "en", theme: "light", width: 1280 });

    // Save a new value for the person.
    await choose({ label: me.displayLabel, text: me.email });
    await valueField.fill("ref-page-002");
    await button(words.save).click();
    await expect.poll(async () => (await readMapping("user", me.id)).value).toBe("ref-page-002");
    await expect(valueField).toHaveValue("ref-page-002");

    // Someone changes the mapping meanwhile: the page's save is refused as stale and the
    // current state is shown.
    const current = await readMapping("user", me.id);
    await writeMapping("user", me.id, "ref-elsewhere-003", current.rowVersion);
    await valueField.fill("ref-page-004");
    await button(words.save).click();
    await expect(section).toContainText(words.conflict);
    await expect(valueField).toHaveValue("ref-elsewhere-003");
    expect((await readMapping("user", me.id)).value).toBe("ref-elsewhere-003");
    await shoot("en-light-1280-conflict");

    // Remove the mapping: the row stays with a newer version and no value.
    const beforeRemove = await readMapping("user", me.id);
    await button(words.remove).click();
    await expect(mapping).toHaveAttribute("data-person-context-mapping", "unmapped");
    const removed = await readMapping("user", me.id);
    expect(removed.value).toBeUndefined();
    expect(typeof removed.rowVersion).toBe("number");
    expect(removed.rowVersion).toBeGreaterThan(beforeRemove.rowVersion ?? 0);
    await shoot("en-light-1280-person-removed");

    // Map the service principal, then remove that mapping too.
    await section.getByRole("radio", { name: words.principal }).click();
    await choose({ label: principalName, text: principalName });
    await expect(mapping).toHaveAttribute("data-person-context-mapping", "unmapped");
    await valueField.fill("svc-ref-005");
    await button(words.save).click();
    await expect(mapping).toHaveAttribute("data-person-context-mapping", "mapped");
    expect((await readMapping("service_principal", principalId)).value).toBe("svc-ref-005");
    await button(words.remove).click();
    await expect(mapping).toHaveAttribute("data-person-context-mapping", "unmapped");
    expect((await readMapping("service_principal", principalId)).value).toBeUndefined();

    // The read is slow, then fails, then succeeds on a retry.
    let readsRefused = true;
    await page.route(
      (url) => isPath(mappingPath)(url),
      async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (readsRefused) return refuse(route, 500);
        return route.continue();
      }
    );
    await open({ locale: "en", theme: "light", width: 1280 });
    await choose({ label: me.displayLabel, text: me.email });
    await expect(section.locator('[aria-busy="true"]')).toBeVisible();
    // The instance's own sentence is shown with the retry.
    await expect(section).toContainText("The suite answered INTERNAL");
    await expect(mapping).toHaveCount(0);
    await shoot("en-light-1280-read-failed");
    readsRefused = false;
    await button(words.tryAgain).click();
    await expect(mapping).toHaveAttribute("data-person-context-mapping", "unmapped");
    await page.unroute((url) => isPath(mappingPath)(url));

    // The list of people fails, then loads on a retry.
    let listRefused = true;
    const usersPath = "/api/v1/instance/users";
    await page.route(
      (url) => isPath(usersPath)(url),
      async (route) => (listRefused ? refuse(route, 500) : route.continue())
    );
    await open({ locale: "en", theme: "light", width: 1280 });
    await expect(section).toContainText(words.listFailed);
    await shoot("en-light-1280-list-failed");
    listRefused = false;
    await button(words.tryAgain).click();
    await expect(chooser).toBeVisible();
    await page.unroute((url) => isPath(usersPath)(url));

    // A reader the instance does not show its people: told why, and the technical ID only
    // behind a closed disclosure.
    for (const locale of ["en", "de"] as const) {
      await page.route(
        (url) => isPath(usersPath)(url),
        (route) => refuse(route, 403)
      );
      await open({ locale, theme: "light", width: 390 });
      const hidden = section.locator('[data-person-context-list="hidden"]');
      await expect(hidden).toContainText(WORDS[locale].peopleHidden);
      const idField = section.locator('[data-connection-field="personContextSubjectId"]');
      await expect(idField).toHaveCount(0);
      await shoot(`${locale}-${locale === "de" ? "dark" : "light"}-390-list-hidden`);
      await hidden.getByRole("button", { name: WORDS[locale].enterId }).click();
      await idField.fill(me.id);
      await idField.press("Enter");
      await expect(mapping).toHaveAttribute("data-person-context-mapping", "unmapped");
      await page.unroute((url) => isPath(usersPath)(url));
    }
  } finally {
    await writeMapping("user", me.id, null, (await readMapping("user", me.id)).rowVersion).catch(
      () => undefined
    );
    if (principalId) await removeServicePrincipal(principalId);
    const found = await page.request.get(assetUrl);
    if (found.ok()) {
      const deleted = await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
        data: { expectedRevision: await assetRevision(page, assetUrl) }
      });
      expect(deleted.ok(), `Delete Connection during cleanup: ${deleted.status()}`).toBe(true);
    }
  }
});
