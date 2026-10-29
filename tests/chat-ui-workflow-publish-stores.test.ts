import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { DraftChangeDialog, createInstanceSource } from "@work-shape/catalyst-chat-ui/workflows";
import { createTranslationContext, instanceSentence } from "./support/chat-ui";
import { renderItem } from "./chat-ui-inbox-harness";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// LIVE-2 on a Workflow's page: one Publish of the Workflow publishes the Data Store drafts its
// steps call first and applies their migrations. The question names each store with the
// migrations it applies, beside the line on the Workflow's own account (LIVE-1); the publish
// names each store at the revision the question showed; a migration that fails says that the
// Workflow is not published. Each test fails without LIVE-2: the read named no store, the
// question said nothing of its migrations and the publish carried none.

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;
const noop = () => undefined;
const { signal } = new AbortController();

const definition = {
  id: "import-findings",
  name: "Import findings",
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "store",
      name: "Store",
      type: "operation",
      operation: "data_store.findings.insert",
      input: {}
    },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
};
const account = "Runs as its own account “Import findings” and may add rows to Findings.";
const findings = {
  name: "findings",
  title: "Findings",
  revision: 3,
  publishedRevision: 2,
  liveLevel: 1,
  pendingMigrations: ["add_note"]
};
const asset = {
  id: "asset_1",
  kind: "workflow",
  name: "import-findings",
  scope: { kind: "instance" },
  revision: 2,
  draftRevision: 2,
  publishedRevision: 1,
  updatedAt: "2026-10-29T09:00:00.000Z",
  config: { name: "import-findings", manifest: definition },
  publishQuestion: [account],
  publishDataStores: [findings]
};

function instance() {
  const { client, calls } = recordedApiClient(({ operation }) => {
    switch (operation) {
      case "assets.get":
        return asset;
      case "assets.list":
        return { items: [] };
      case "workflows.list":
        return { items: [] };
      default:
        return { draftRevision: 2, publishedRevision: 2 };
    }
  });
  return { source: createInstanceSource(client, "k"), calls };
}

const dialog = (locale: "en" | "de", stores = [findings], question = [account]) =>
  renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(DraftChangeDialog, {
        change: "publish",
        name: "Import findings",
        revision: 2,
        publishedRevision: 1,
        question,
        stores,
        loading: false,
        error: undefined,
        onConfirm: noop,
        onClose: noop
      })
    })
  );

describe("LIVE-2: the publish question of a Workflow names the stores it publishes first", () => {
  it("carries the pending stores from the read of the asset to the draft", async () => {
    const { source } = instance();
    const workflow = await source.getWorkflow("cw_1", "import-findings", signal);
    expect(workflow.draft?.publishDataStores).toEqual([
      { name: "findings", title: "Findings", revision: 3, pendingMigrations: ["add_note"] }
    ]);
    expect(workflow.draft?.publishQuestion).toEqual([account]);
  });

  it("names the store's migration and the account in the one question", () => {
    const html = dialog("en");
    expect(html).toContain(
      t("workflows.draft.publishStoreMigrationOne", {
        title: "Findings",
        migrations: "add_note"
      })
    );
    expect(html).toContain(account);
    // The store comes first: it is published and migrated before the Workflow goes live.
    expect(html.indexOf("Findings” first")).toBeLessThan(html.indexOf(account));
  });

  it("names several migrations, and a store whose draft brings none, in German too", () => {
    const html = dialog("de", [
      { ...findings, pendingMigrations: ["add_note", "add_due"] },
      { ...findings, name: "clients", title: "Mandanten", pendingMigrations: [] }
    ]);
    expect(html).toContain(
      de("workflows.draft.publishStoreMigrations", {
        title: "Findings",
        count: "2",
        migrations: "add_note und add_due"
      })
    );
    expect(html).toContain(de("workflows.draft.publishStore", { title: "Mandanten" }));
  });

  it("publishes each store at the revision the question showed", async () => {
    const { source, calls } = instance();
    await source.drafts?.publish("import-findings", 2, undefined, [
      { name: "findings", revision: 3 }
    ]);
    expect(calls[0]).toMatchObject({
      operation: "assets.publish",
      params: { kind: "workflow", name: "import-findings" }
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      revision: 2,
      dataStores: [{ name: "findings", revision: 3 }]
    });
  });

  it("says that the Workflow is not published when a store's migration fails", () => {
    const refusal = (publishing?: "workflow") =>
      new ApiError(409, "refused", {
        error: {
          code: "CONFLICT",
          message: "The migration failed.",
          details: {
            reason: "data_store_migration_failed",
            dataStore: "findings",
            title: "Findings",
            migration: "add_note",
            level: 1,
            ...(publishing ? { publishing } : {})
          }
        }
      });
    expect(instanceSentence(refusal("workflow"), t)).toBe(
      t("refusals.dataStoreMigrationFailedWorkflow", {
        dataStore: "Findings",
        migration: "add_note"
      })
    );
    expect(instanceSentence(refusal("workflow"), de)).toContain(
      "Der Workflow ist nicht veröffentlicht"
    );
    // An App's Publish keeps its own sentence.
    expect(instanceSentence(refusal(), t)).toContain("The app is not published");
  });
});

describe("LIVE-2: the Inbox item of a held Workflow publish names the store it publishes first", () => {
  const review = (kind: string, name: string, title: string, revision: number, live: number) => ({
    kind,
    name,
    title,
    revision,
    liveRevision: live,
    files: [],
    hostsAdded: [],
    connections: [],
    dataStores: []
  });
  const item = (locale: "en" | "de") =>
    renderItem(
      {
        kind: "workflow_publish",
        summary: "assets.publish",
        preview: {
          runId: "opr_1",
          operation: "assets.publish",
          effect: "changing",
          actor: { kind: "user", id: "usr_kai", label: "Kai Member" },
          origin: { kind: "user" },
          inputs: [{ key: "revision", value: "2" }],
          review: {
            ...review("workflow", "import-findings", "Import findings", 2, 1),
            publishedWith: [review("data_store", "findings", "Findings", 3, 2)]
          }
        },
        canDecide: true
      },
      { locale }
    );

  it("lists the store with the version it makes live", () => {
    const markup = item("en");
    const list = markup.indexOf('data-testid="publish-review-published-with"');
    expect(list).toBeGreaterThan(-1);
    const storeAt = markup.indexOf("Data store “Findings”", list);
    expect(storeAt).toBeGreaterThan(list);
    expect(markup.indexOf("Version 3, in place of version 2", storeAt)).toBeGreaterThan(storeAt);
    expect(item("de")).toContain("Datenspeicher „Findings“");
  });
});
