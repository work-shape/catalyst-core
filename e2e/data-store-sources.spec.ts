import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Page } from "@playwright/test";
import { z } from "zod";
import {
  ALLOWED_URL,
  plantConnection,
  removeConnection,
  removeServicePrincipal
} from "./connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";

// A store's page says where its rows come from and who reads them, and an App on the store says
// where the data it shows was copied from (DS-13a, the screens half of check 68). Everything is
// written and published over the API as a builder would; the Connection is planted as the
// release seed writes it.

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const idSchema = z.object({ id: z.string() });
const revisionSchema = z.object({ revision: z.number() });

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** Writes one asset and publishes the revision the write made. */
async function publishAsset(
  page: Page,
  kind: string,
  name: string,
  body: Record<string, unknown>
): Promise<void> {
  const address = `${apiOrigin}/api/v1/assets/${kind}/${name}`;
  const saved = await requestWithOrigin(page, "put", address, {
    data: { expectedRevision: null, ...body },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { revision } = revisionSchema.parse(await saved.json());
  const published = await requestWithOrigin(page, "post", `${address}/publish`, {
    data: {
      revision,
      ...("workspaceId" in body ? { workspaceId: body.workspaceId } : {})
    },
    timeout: 90_000
  });
  expect(published.ok(), await published.text()).toBe(true);
}

type UsedBy = Record<string, unknown> & { hidden: Record<string, number> };

const nobody = { holders: [], hiddenHolders: 0 };

/** Nothing uses the store. */
const nothing: UsedBy = {
  apps: [],
  workflows: [],
  knowledgeBases: [],
  readers: nobody,
  hidden: { apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 },
  truncated: false
};

/**
 * What a member who administers no users is answered: the account as its kind, holders as a
 * number, and what the member may not see counted in its section.
 */
const memberView: UsedBy = {
  apps: [
    {
      id: "asset_board",
      name: "besuchsboard",
      title: "Besuchsboard",
      reads: true,
      writes: false,
      sources: [],
      audience: { workspace: { title: "Vertrieb", members: 12 }, holders: [], hiddenHolders: 2 }
    }
  ],
  workflows: [
    {
      id: "asset_import",
      name: "nachtimport",
      title: "Nachtimport",
      reads: false,
      writes: true,
      sources: [{ connection: "exampledata", title: "Exampledata" }],
      account: {}
    },
    {
      id: "asset_report",
      name: "wochenbericht",
      title: "Wochenbericht",
      reads: true,
      writes: false,
      sources: [],
      account: {}
    }
  ],
  knowledgeBases: [
    {
      id: "asset_knowledge",
      name: "kundenwissen",
      title: "Kundenwissen",
      audience: { holders: [], hiddenHolders: 4 }
    }
  ],
  readers: { holders: [], hiddenHolders: 3 },
  hidden: { apps: 1, workflows: 1, knowledgeBases: 0, fills: 1, reads: 1 },
  truncated: false
};

/** What an admin is answered: every holder by name, a person, a role and a technical account. */
const namedHolders: UsedBy = {
  ...memberView,
  knowledgeBases: [
    {
      id: "asset_knowledge",
      name: "kundenwissen",
      title: "Kundenwissen",
      audience: {
        holders: [{ kind: "user", name: "usr_kai", title: "Kai Berger" }],
        hiddenHolders: 0
      }
    }
  ],
  readers: {
    holders: [
      { kind: "user", name: "usr_lena", title: "Lena Vogt" },
      { kind: "role", name: "controlling", title: "controlling" },
      { kind: "service_principal", name: "sp_report", title: "Auswertung" }
    ],
    hiddenHolders: 0
  },
  hidden: { apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 }
};

/** An App on two stores, one filled by a Workflow and an App, one by nothing. */
function severalSources(kunden: string) {
  return {
    stores: [
      {
        name: "kunden",
        title: kunden,
        fillers: [
          {
            kind: "workflow",
            name: "nachtimport",
            title: "Nachtimport",
            connections: ["Exampledata"]
          },
          { kind: "app", name: "erfassung", title: "Erfassung", connections: [] }
        ]
      },
      {
        name: "termine",
        title: "Termine",
        fillers: [
          {
            kind: "workflow",
            name: "kalender",
            title: "Kalenderabgleich",
            connections: ["Outlook", "CRM"]
          }
        ]
      },
      { name: "notizen", title: "Notizen", fillers: [] }
    ],
    truncated: false
  };
}

/** One picture at 1280 pixels, light, in English, where `E2E_SHOTS_DIR` names a folder. */
async function shootOne(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  await ready();
  await page.screenshot({
    path: join(shotsDir, `${name}-1280-light-en.png`),
    animations: "disabled"
  });
}

/**
 * Pictures of one state at 1280 pixels, light, in English, and at 390, dark, in German, where
 * `E2E_SHOTS_DIR` names a folder. Each loads the address again and waits for `ready`.
 */
async function shootTwo(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  const size = page.viewportSize();
  for (const [width, theme, locale] of [
    [1280, "light", "en"],
    [390, "dark", "de"]
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.evaluate(
      ([themeValue, localeValue]) => {
        window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        window.localStorage.setItem("vivd-catalyst:locale", localeValue);
      },
      [theme, locale] as const
    );
    await page.reload();
    await ready();
    await page.screenshot({
      path: join(shotsDir, `${name}-${width}-${theme}-${locale}.png`),
      animations: "disabled"
    });
  }
  await page.evaluate(() => {
    window.localStorage.setItem("vivd-catalyst:theme", "light");
    window.localStorage.setItem("vivd-catalyst:locale", "en");
  });
  if (size) {
    await page.setViewportSize(size);
  }
  await page.reload();
}

test("a store's page names the Workflow that fills it with its Connection and account, and who reads it; the App on it says where its data was copied from, and its Publish dialog who would see it", async ({
  page,
  // It plants a Connection no release config names.
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const tag = randomUUID().slice(0, 6);
  const store = `kunden-${tag}`;
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `exampledata_${tag}`,
    displayName: "Exampledata",
    url: ALLOWED_URL,
    authScheme: "none" as const,
    operations: [
      { name: "echo", effect: "reading", exposure: ["workflow"], enabled: true }
    ] as const
  };
  const workflow = `nachtimport-${tag}`;
  const account = `nachtimport-konto-${tag}`;
  const app = `kundenliste-${tag}`;
  const workspaceTitle = `Kai Spezis ${tag}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: workspaceTitle, defaultConversationVisibility: "private" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  let principalId: string | undefined;
  try {
    await plantConnection(connection);

    // The instance-owned Workflow and the workspace's App may both reference this store.
    await publishAsset(page, "data_store", store, {
      files: [
        { path: "store.yaml", text: `id: ${store}\nname: Kunden ${tag}\n` },
        {
          path: "migrations/0001_init.sql",
          text: "create table kunden (id bigint generated by default as identity primary key, name text not null);"
        }
      ]
    });
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await (await page.request.get(`${apiOrigin}/api/v1/data-stores/${store}`)).json()
          ),
        { timeout: 60_000 }
      )
      .toContain('"ready"');

    // Nachtimport reads Exampledata and adds its rows to the store, as its own account.
    const principal = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/instance/service-principals`,
      {
        data: {
          name: account,
          displayLabel: "Nachtimport-Konto",
          description: "Runs the nightly import of a spec."
        }
      }
    );
    expect(principal.ok(), await principal.text()).toBe(true);
    principalId = z.object({ principal: idSchema }).parse(await principal.json()).principal.id;
    await publishAsset(page, "workflow", workflow, {
      config: {
        name: workflow,
        manifest: {
          id: workflow,
          kind: "data",
          name: "Nachtimport",
          description: "Copies the clients of Exampledata every night.",
          runAs: account,
          inputs: { type: "object", properties: {}, additionalProperties: false },
          outputs: { type: "object", properties: {} },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "read",
              name: "Read the clients",
              type: "operation",
              operation: `connection.${connection.name}.echo`,
              input: { text: { value: "clients" } }
            },
            {
              id: "store",
              name: "Add the clients",
              type: "operation",
              operation: `data_store.${store}.insert`,
              input: { table: { value: "kunden" }, rows: { value: [{ name: "Muster GmbH" }] } }
            },
            { id: "result", name: "Result", type: "output", input: {} }
          ]
        }
      }
    });

    // An App of the workspace that lists the store's rows.
    await publishAsset(page, "app", app, {
      workspaceId,
      files: [
        {
          path: "app.yaml",
          text: JSON.stringify({
            id: app,
            name: "Kundenliste",
            kit: "1.1.0",
            entry: "index.html",
            dataStores: [{ name: store, minSchema: 1 }],
            actions: [{ name: "list_kunden", file: "actions/list_kunden.sql", effect: "reading" }]
          })
        },
        { path: "index.html", text: "<!doctype html><title>Kundenliste</title><p>Kunden</p>" },
        {
          path: "actions/list_kunden.sql",
          text: "-- The clients, by name.\n-- @param limit integer\nselect name from kunden order by name limit $limit\n"
        }
      ]
    });

    // The store's page: Nachtimport fills it from Exampledata as its account; the workspace reads
    // it through the App, and only the admins read the store itself.
    // Studio works at instance scope, matching the store's owner.
    await page.goto("/");
    await page.evaluate(
      (scope) => window.localStorage.setItem("vivd-catalyst:build-scope", scope),
      "instance"
    );
    const storePage = `/build/data-stores/${store}`;
    await page.goto(storePage);
    const filler = page.locator('[data-data-store-role="filled-by"]');
    await expect(filler).toHaveCount(1);
    await expect(filler).toContainText("Nachtimport");
    await expect(filler).toContainText("Copies from Exampledata · Runs as Nachtimport-Konto");
    const reader = page.locator('[data-data-store-role="read-by"]');
    await expect(reader).toHaveCount(1);
    await expect(reader).toContainText("Kundenliste");
    await expect(reader).toContainText(`Everyone in ${workspaceTitle} (1 person)`);
    // Being a member opens the workspace's Apps, not its store.
    await expect(page.locator("[data-data-store-readers]")).toContainText("Only instance admins");
    await expect(page.locator("[data-data-store-admins]")).toHaveText(
      "Instance admins always see everything."
    );
    await shootTwo(page, "ds-13a-store-top", async () => {
      await expect(page.locator('[data-data-store-role="filled-by"]')).toBeVisible();
    });

    // The states a reader meets on other instances, from answers the page is given.
    const answer = (used: UsedBy) =>
      page.route(`**/api/v1/data-stores/${store}/used-by`, (route) =>
        route.fulfill({ json: used })
      );
    const showSection = (id: string) => async () => {
      await expect(page.locator("#filled-by")).toBeVisible();
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    };
    for (const [name, used, section] of [
      ["filled-by-empty", nothing, "filled-by"],
      [
        "filled-by-hidden-only",
        { ...nothing, hidden: { ...nothing.hidden, workflows: 1, fills: 1 } },
        "filled-by"
      ],
      ["member-view", memberView, "filled-by"],
      ["member-view-read-by", memberView, "read-by"],
      ["named-holders", namedHolders, "read-by"]
    ] as const) {
      await page.unroute(`**/api/v1/data-stores/${store}/used-by`);
      await answer(used);
      await page.goto(storePage);
      await shootTwo(page, `ds-13a-${name}`, showSection(section));
    }
    await page.unroute(`**/api/v1/data-stores/${store}/used-by`);

    // Whoever uses the App reads where its data comes from beside its name, and a builder
    // finds it first in the App's details.
    const appPage = `/w/${workspaceId}/apps/${app}`;
    await page.goto(appPage);
    const sourcesButton = page.getByRole("button", { name: "Where the data comes from" });
    await sourcesButton.click();
    await expect(page.locator("[data-app-data-sources-popover]")).toHaveText(
      `Shows data from “Kunden ${tag}”, which the Workflow “Nachtimport” copies from Exampledata.`
    );
    await shootTwo(page, "ds-13a-app-sources", async () => {
      await page
        .getByRole("button", { name: /^(?:Where the data comes from|Woher die Daten kommen)$/u })
        .click();
      await expect(page.locator("[data-app-data-sources-popover]")).toBeVisible();
    });
    // The App's head at 1280, as whoever uses it opens it: the title, Edit, the sources button.
    await page.goto(appPage);
    await expect(sourcesButton).toBeVisible();
    await shootOne(page, "ds-13a-app-head", async () => {
      await page.getByRole("button", { name: "Where the data comes from" }).click();
      await expect(page.locator("[data-app-data-sources-popover]")).toBeVisible();
    });
    const openDetails = async () => {
      await page.goto(appPage);
      await page.getByRole("button", { name: /^(?:More actions|Weitere Aktionen)$/u }).click();
      await page.getByRole("menuitem", { name: "Details", exact: true }).click();
      await expect(page.locator("[data-app-data-sources]")).toBeVisible();
    };
    await openDetails();
    await expect(page.locator("[data-app-data-sources]")).toHaveText(
      `Shows data from “Kunden ${tag}”, which the Workflow “Nachtimport” copies from Exampledata.`
    );
    // Several stores and fillers, from an answer the page is given.
    await page.route("**/api/v1/app-data-sources?*", (route) =>
      route.fulfill({ json: severalSources(`Kunden ${tag}`) })
    );
    await shootTwo(page, "ds-13a-app-details-several", openDetails);
    await page.unroute("**/api/v1/app-data-sources?*");

    // DS-13b, check 67: the Publish dialog names who would see which stored data, for the
    // revision it publishes. The draft, revision 2, reads the store with a second action.
    const drafted = await requestWithOrigin(page, "put", `${apiOrigin}/api/v1/assets/app/${app}`, {
      data: {
        workspaceId,
        expectedRevision: 1,
        files: [
          {
            path: "app.yaml",
            text: JSON.stringify({
              id: app,
              name: "Kundenliste",
              kit: "1.1.0",
              entry: "index.html",
              dataStores: [{ name: store, minSchema: 1 }],
              actions: [
                { name: "list_kunden", file: "actions/list_kunden.sql", effect: "reading" },
                { name: "by_name", file: "actions/by_name.sql", effect: "reading" }
              ]
            })
          },
          { path: "index.html", text: "<!doctype html><title>Kundenliste</title><p>Kunden</p>" },
          {
            path: "actions/list_kunden.sql",
            text: "-- The clients, by name.\n-- @param limit integer\nselect name from kunden order by name limit $limit\n"
          },
          {
            path: "actions/by_name.sql",
            text: "-- One client.\n-- @param name text\nselect name from kunden where name = $name\n"
          }
        ]
      },
      timeout: 90_000
    });
    expect(drafted.ok(), await drafted.text()).toBe(true);
    const edit = page.getByTestId("app-edit");
    const publishDialog = page.getByRole("dialog", { name: "Publish “Kundenliste”?" });
    const openPublish = async () => {
      await page.goto(`/w/${workspaceId}/app-drafts/${app}`);
      await edit.getByRole("button", { name: /^(?:Publish|Veröffentlichen)$/u }).click();
      // The plain sentence leads (PUBQ-1); the lines on stored data stand behind Details.
      await expect(page.getByRole("dialog").getByTestId("publish-narrative-summary")).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Details", exact: true }).click();
      await expect(page.getByRole("dialog").locator('[data-field="data-stored"]')).toBeVisible();
    };
    await openPublish();
    await expect(publishDialog.locator('[data-field="data-audience"]')).toContainText(
      `Everyone in ${workspaceTitle} (1 person)`
    );
    const storeLine = publishDialog.locator(`[data-data-store="${store}"]`);
    await expect(storeLine).toContainText(`Kunden ${tag}`);
    await expect(storeLine).toContainText("2 actions read from it:");
    await expect(storeLine).toContainText("list_kunden");
    await expect(storeLine).toContainText("by_name");
    // The rows are named as what bounds what the actions show, never as what they select.
    await expect(storeLine.locator("[data-data-store-rows]")).toContainText(
      "What they show depends on their inputs."
    );
    await expect(storeLine).toContainText(
      `Shows data from “Kunden ${tag}”, which the Workflow “Nachtimport” copies from Exampledata.`
    );
    await expect(publishDialog).not.toContainText("select name");
    await shootTwo(page, "ds-13b-publish-dialog", openPublish);
    await openPublish();
    await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(publishDialog).toBeHidden();
    await expect(edit.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();

    // Publishing an older revision again names what that revision reads, not what is live.
    await edit.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Revisions" }).click();
    const revisions = page.getByRole("dialog", { name: "Revisions" });
    await revisions
      .locator('[data-revision="1"]')
      .getByRole("button", { name: "Publish this revision" })
      .click();
    await expect(publishDialog.locator(`[data-data-store="${store}"]`)).toContainText(
      "The action list_kunden reads from it."
    );
    await expect(publishDialog).not.toContainText("by_name");
    await publishDialog.getByRole("button", { name: "Details", exact: true }).click();
    await shootOne(page, "ds-13b-publish-older-revision", async () => {
      await expect(publishDialog.locator('[data-field="data-stored"]')).toBeVisible();
    });
    await publishDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(publishDialog).toBeHidden();
  } finally {
    await removeConnection(connection.id);
    if (principalId) {
      await removeServicePrincipal(principalId);
    }
  }
});
