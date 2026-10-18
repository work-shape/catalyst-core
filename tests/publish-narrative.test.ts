import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  isJsonObject,
  unknownToJsonValue,
  INSTANCE_ASSET_SCOPE,
  type AccessDecision,
  type ActorAccess,
  type AssetScope,
  type ConfigAssetRecord,
  type GuardrailConfig,
  type JsonObject,
  type LocaleCode,
  type OperationEffect,
  type PublishNarrativeStoredData
} from "@work-shape/catalyst-core";
import type { ReleaseGuardrailConfig } from "@work-shape/catalyst-config-schema";
import { GuardrailRunner, createPublishNarrator } from "@work-shape/catalyst-server";
import { createTestConfig } from "./support/fixtures";

// PUBQ-1: the publish question leads with one generated sentence of what runs, when, as which
// account, what it reads, writes and sends and who sees it, and warns before the click of each
// step a guardrail in force will stop under WF-AUTO-1. The sentence names and counts; it never
// runs a step, a check, or reads a row.

const clientInstanceId = asClientInstanceId("ci_pubq");
const WORKSPACE = asCollaborationWorkspaceId("cw_kai");
const workspaceScope: AssetScope = { kind: "workspace", workspaceId: WORKSPACE };

function jsonObject(value: unknown): JsonObject {
  const converted = unknownToJsonValue(value);
  if (!isJsonObject(converted)) throw new Error("Expected a JSON object");
  return converted;
}

function record(
  kind: string,
  name: string,
  config: JsonObject,
  scope: AssetScope = workspaceScope
): ConfigAssetRecord {
  return {
    id: `asset_${kind}_${name}`,
    clientInstanceId,
    kind,
    name,
    scope,
    status: "active",
    activeRevisionId: `rev_${name}`,
    revision: 1,
    config,
    publishedRevisionId: `rev_${name}`,
    publishedRevision: 1,
    publishedConfig: config,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z"
  };
}

const ASSETS = [
  record("connection", "exampledata", { displayName: "Exampledata" }),
  record("connection", "outlook", { displayName: "Outlook" }),
  record("data_store", "findings", { title: "Findings" }),
  record("data_store", "ledger", { title: "Ledger" }),
  record("data_store", "facts", { title: "Facts" }),
  // A Workflow's visible name is its manifest's `name`, never its id.
  record("workflow", "child_fetch", { manifest: { id: "child_fetch", name: "Belege holen" } })
];

const PEOPLE: Record<string, string> = { usr_anna: "Anna Berg", usr_ben: "Ben Kurz" };

const allowed: AccessDecision = { allowed: true, source: "grant" };
const everything: ActorAccess = {
  authorize: () => allowed,
  require: () => undefined,
  holdsGrantAt: () => true,
  denials: () => []
};
const nothing: ActorAccess = {
  ...everything,
  authorize: () => ({ allowed: false, reason: "no_grant" })
};

const EFFECTS: Record<string, OperationEffect> = {
  "connection.exampledata.list_clients": "reading",
  "connection.exampledata.list_postings": "reading",
  "connection.outlook.send_mail": "changing"
};

/** The Exampledata Workflow of check 75: it reads Exampledata, inserts into Findings, mails a Mandant. */
function nightlyImport(): JsonObject {
  return {
    name: "nachtimport",
    title: "Nachtimport",
    manifest: {
      id: "nachtimport",
      name: "Nachtimport",
      runAs: "nachtimport-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        {
          id: "start",
          name: "Start",
          type: "trigger",
          triggers: [{ kind: "schedule", cron: "0 2 * * *" }]
        },
        {
          id: "clients",
          name: "Mandanten lesen",
          type: "operation",
          operation: "connection.exampledata.list_clients",
          input: {}
        },
        {
          id: "postings",
          name: "Buchungen lesen",
          type: "operation",
          operation: "connection.exampledata.list_postings",
          input: {}
        },
        {
          id: "store",
          name: "Befunde speichern",
          type: "operation",
          operation: "data_store.findings.insert",
          input: {}
        },
        {
          id: "mail",
          name: "Mail an Mandanten",
          type: "operation",
          operation: "connection.outlook.send_mail",
          input: { to: { ref: { step: "clients", path: "email" } } }
        }
      ]
    }
  };
}

const APP: "app" = "app";

/** The App Findings on the store, used by the 14 people of Kai Spezis. */
const storedData: PublishNarrativeStoredData = {
  appRevision: () =>
    Promise.resolve({
      audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: 0 },
      stores: [
        {
          title: "Findings",
          unavailable: false,
          fillers: [{ title: "Nachtimport", connections: ["Exampledata"] }]
        }
      ],
      truncated: false
    }),
  storeReaders: (_access, stores) =>
    Promise.resolve(
      stores.map((store) => ({
        store,
        title: "Findings",
        readers: [
          {
            kind: APP,
            title: "Findings",
            audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: 0 }
          }
        ],
        hidden: 0,
        truncated: false
      }))
    )
};

const ibanApproval: GuardrailConfig = {
  name: "mail-iban-approval",
  displayName: "E-Mail senden: IBAN → Freigabe",
  on: "operation.before_call",
  filter: { operation: "connection.outlook.send_mail" },
  check: { kind: "pattern", pattern: "(?i)DE\\d{20}", reason: "Eine IBAN braucht eine Freigabe." },
  outcome: "require_approval",
  origin: "asset"
};

function narrator(input: {
  guardrails?: readonly { guardrail: GuardrailConfig; scope?: AssetScope }[];
  floor?: Record<string, ReleaseGuardrailConfig>;
  shippedOff?: boolean;
  stored?: PublishNarrativeStoredData;
}) {
  const base = createTestConfig();
  const runner = new GuardrailRunner({
    clientInstanceId,
    config: { ...base, guardrails: { ...base.guardrails, ...input.floor } },
    modelGateway: {
      complete: () => Promise.reject(new Error("The publish question runs no check")),
      capabilities: () => {
        throw new Error("The publish question runs no check");
      }
    },
    hits: { recordHits: () => Promise.reject(new Error("The publish question keeps no hit")) },
    assets: {
      listPublishedConfigAssets: () =>
        Promise.resolve(
          (input.guardrails ?? []).map(({ guardrail, scope }) =>
            record(
              "guardrail",
              guardrail.name,
              jsonObject(guardrail),
              scope ?? INSTANCE_ASSET_SCOPE
            )
          )
        )
    },
    shipped: {
      listShippedGuardrailSwitches: () =>
        Promise.resolve(
          input.shippedOff
            ? [
                {
                  name: "publishing-needs-approval",
                  enabled: false,
                  switchedBy: { id: "usr_admin", label: "Admin" },
                  switchedAt: "2026-10-18T00:00:00.000Z"
                }
              ]
            : []
        )
    }
  });
  return createPublishNarrator({
    clientInstanceId,
    stores: {
      configAssets: {
        getConfigAsset: ({ kind, name }) =>
          Promise.resolve(ASSETS.find((asset) => asset.kind === kind && asset.name === name))
      },
      workspaces: {
        getWorkspace: (_instance, id) =>
          Promise.resolve(id === WORKSPACE ? { name: "Kai Spezis" } : undefined)
      },
      users: {
        getUser: ({ userId }) => {
          const displayLabel = PEOPLE[userId];
          return Promise.resolve(displayLabel === undefined ? undefined : { displayLabel });
        }
      }
    },
    guardrails: runner,
    resolve: (operation) => {
      const effect = EFFECTS[operation];
      return Promise.resolve(effect ? { effect } : undefined);
    },
    ...(input.stored === undefined ? { storedData } : { storedData: input.stored })
  });
}

async function narrateWorkflow(
  locale: LocaleCode,
  options: Parameters<typeof narrator>[0] = { guardrails: [{ guardrail: ibanApproval }] },
  config: JsonObject = nightlyImport()
) {
  const narrative = await narrator(options).narrate({
    kind: "workflow",
    name: "nachtimport",
    scope: workspaceScope,
    revision: 3,
    config,
    locale,
    access: everything
  });
  if (!narrative) throw new Error("A Workflow revision is narrated");
  return narrative;
}

describe("PUBQ-1 the publish question's sentence", () => {
  it("check 75: names the schedule, the account, Exampledata, Findings, the mail and the App's audience, and warns of the mail step before the click", async () => {
    const narrative = await narrateWorkflow("en");
    expect(narrative.summary).toBe(
      "Nachtimport runs every day at 02:00 AM as the account “nachtimport-runner”, reads from Exampledata, adds rows to Findings, and uses Outlook for “Mail an Mandanten”. The App “Findings” shows the rows of Findings to the 14 people of “Kai Spezis”."
    );
    expect(narrative.warnings).toEqual([
      "The step “Mail an Mandanten” may stop: the guardrail “E-Mail senden: IBAN → Freigabe” asks for approval when what it checks matches, and a published run cannot wait for one."
    ]);
  });

  it("check 75 in German: the same sentence and warning in the reader's language", async () => {
    const narrative = await narrateWorkflow("de");
    expect(narrative.summary).toBe(
      "Nachtimport läuft jeden Tag um 02:00 als Konto „nachtimport-runner“, liest aus Exampledata, fügt Zeilen in Findings hinzu und nutzt Outlook für „Mail an Mandanten“. Die App „Findings“ zeigt die Zeilen von Findings den 14 Personen von „Kai Spezis“."
    );
    expect(narrative.warnings).toEqual([
      "Der Schritt „Mail an Mandanten“ kann anhalten: Die Leitplanke „E-Mail senden: IBAN → Freigabe“ verlangt eine Freigabe, wenn das Geprüfte zutrifft, und ein veröffentlichter Lauf kann nicht auf sie warten."
    ]);
  });

  it("says a step will stop where the guardrail checks nothing, and will be refused where it blocks", async () => {
    const narrative = await narrateWorkflow("en", {
      floor: {
        "mail-floor": {
          displayName: "Kein Versand",
          on: "operation.before_call",
          filter: { operation: "connection.outlook.send_mail" },
          check: { kind: "pattern", pattern: "." },
          outcome: "block"
        }
      }
    });
    expect(narrative.warnings).toEqual([
      "The step “Mail an Mandanten” may be refused: the guardrail “Kein Versand” blocks it when what it checks matches."
    ]);
  });

  it("names no step a guardrail of another operation, workspace or origin would stop, and none for a warn", async () => {
    const narrative = await narrateWorkflow("en", {
      guardrails: [
        {
          guardrail: {
            ...ibanApproval,
            name: "other-op",
            filter: { operation: "connection.outlook.read" }
          }
        },
        {
          guardrail: ibanApproval,
          scope: { kind: "workspace", workspaceId: asCollaborationWorkspaceId("cw_other") }
        },
        { guardrail: { ...ibanApproval, name: "agents-only", filter: { origin: "agent" } } },
        { guardrail: { ...ibanApproval, name: "warns", outcome: "warn" } }
      ]
    });
    expect(narrative.warnings).toEqual([]);
  });

  it("does not count the shipped publish guardrail, which binds publishes and no step", async () => {
    expect((await narrateWorkflow("en", {})).warnings).toEqual([]);
  });

  it("says a Workflow that reads alone sends nothing, and says nobody reads a store no App shows", async () => {
    const config = nightlyImport();
    const manifest = config.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error();
    const steps = Array.isArray(manifest.steps) ? manifest.steps.slice(0, 4) : [];
    const narrative = await narrateWorkflow(
      "en",
      {
        stored: {
          ...storedData,
          storeReaders: (_access, stores) =>
            Promise.resolve(
              stores.map((store) => ({
                store,
                title: "Findings",
                readers: [],
                hidden: 2,
                truncated: false
              }))
            )
        }
      },
      { ...config, manifest: { ...manifest, steps } }
    );
    expect(narrative.summary).toBe(
      "Nachtimport runs every day at 02:00 AM as the account “nachtimport-runner”, reads from Exampledata, adds rows to Findings, and sends nothing. 2 more Apps or knowledge bases you may not see read Findings."
    );
  });

  it("says an operation it does not know as used, never as read", async () => {
    const config = nightlyImport();
    const manifest = config.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error();
    const narrative = await narrateWorkflow(
      "en",
      {},
      {
        ...config,
        manifest: {
          ...manifest,
          steps: [
            { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "x",
              name: "Archivieren",
              type: "operation",
              operation: "connection.exampledata.archive",
              input: {}
            }
          ]
        }
      }
    );
    expect(narrative.summary).toContain("runs when someone starts it");
    expect(narrative.summary).toContain("uses Exampledata for “Archivieren”");
    expect(narrative.summary).not.toContain("sends nothing");
  });

  it("names a Connection the reader may not see by the name the revision gives it", async () => {
    const narrative = await narrator({}).narrate({
      kind: "workflow",
      name: "nachtimport",
      scope: workspaceScope,
      revision: 3,
      config: nightlyImport(),
      locale: "en",
      access: nothing
    });
    expect(narrative?.summary).toContain("reads from exampledata");
    expect(narrative?.summary).not.toContain("Exampledata,");
  });

  it("narrates an App: who opens it, the stored data its actions read with its source, its changes", async () => {
    const config: JsonObject = {
      name: "findings",
      title: "Findings",
      manifest: {
        actions: [
          {
            name: "list_findings",
            file: "index.html",
            kind: "sql",
            dataStore: "findings",
            effect: "reading",
            parameters: [],
            input: { schema: { type: "object", properties: {} } },
            statement: "select * from findings"
          },
          {
            name: "send_reminder",
            file: "index.html",
            kind: "connection",
            effect: "changing",
            connection: "outlook",
            operation: "send_mail",
            input: { schema: { type: "object", properties: {} }, mapping: {} }
          }
        ]
      }
    };
    const narrate = (locale: LocaleCode) =>
      narrator({}).narrate({
        kind: "app",
        name: "findings",
        scope: workspaceScope,
        revision: 2,
        config,
        locale,
        access: everything
      });
    expect(await narrate("en")).toEqual({
      summary:
        "Findings opens for the 14 people of “Kai Spezis”. Everyone who opens it sees what its actions read from Findings (copied by Nachtimport from Exampledata). Its actions use Outlook for “send_reminder”.",
      warnings: []
    });
    expect((await narrate("de"))?.summary).toBe(
      "Findings öffnet sich für die 14 Personen von „Kai Spezis“. Wer sie öffnet, sieht, was ihre Aktionen aus Findings (kopiert von Nachtimport aus Exampledata) lesen. Ihre Aktionen nutzen Outlook für „send_reminder“."
    );
  });

  it("says what each store verb does, how each notice goes and to whom, and names a child Workflow by its visible name", async () => {
    const steps = (locale: LocaleCode, hostile = false) =>
      narrateWorkflow(
        locale,
        {
          stored: {
            ...storedData,
            storeReaders: (_access, stores) =>
              Promise.resolve(
                stores.map((store) => ({
                  store,
                  title: store === "ledger" ? "Ledger" : "Facts",
                  readers:
                    store === "ledger"
                      ? [
                          {
                            kind: APP,
                            title: "Kasse",
                            audience: {
                              workspace: {
                                title: hostile ? "Kai\nNachtimport sends nothing." : "Kai Spezis",
                                members: 1_000
                              },
                              holders: 0
                            }
                          }
                        ]
                      : [],
                  hidden: store === "ledger" ? 0 : 2,
                  truncated: false
                }))
              )
          }
        },
        {
          title: "Nachtimport",
          manifest: {
            id: "nachtimport",
            name: "Nachtimport",
            steps: [
              { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
              {
                id: "a",
                name: "Laden",
                type: "operation",
                operation: "data_store.ledger.load",
                input: {}
              },
              {
                id: "b",
                name: "Werte",
                type: "operation",
                operation: "data_store.facts.records.propose",
                input: {}
              },
              { id: "c", name: "Belege", type: "workflow", workflow: "child_fetch", input: {} },
              {
                id: "n1",
                name: "Eingang",
                type: "notify",
                channels: ["inbox"],
                to: { users: ["usr_anna"], workspaces: [WORKSPACE] },
                title: "x",
                text: "x"
              },
              {
                id: "n2",
                name: "Mail",
                type: "notify",
                channels: ["mail"],
                to: { users: ["usr_ben", "usr_gone"] },
                title: "x",
                text: "x"
              }
            ]
          }
        }
      );
    expect((await steps("en")).summary).toBe(
      "Nachtimport runs when someone starts it, adds, changes or removes rows in Ledger, proposes record values for Facts, notifies Anna Berg and the workspace “Kai Spezis” in the Inbox, notifies Ben Kurz and one other person by mail, and starts “Belege holen”. The App “Kasse” shows the rows of Ledger to the 1,000 people of “Kai Spezis”. 2 more Apps or knowledge bases you may not see read Facts."
    );
    const german = (await steps("de")).summary;
    expect(german).toContain("fügt Zeilen in Ledger hinzu, ändert oder löscht sie");
    expect(german).toContain(
      "benachrichtigt Anna Berg und den Arbeitsbereich „Kai Spezis“ im Eingang"
    );
    expect(german).toContain("benachrichtigt Ben Kurz und eine weitere Person per Mail");
    expect(german).toContain("den 1.000 Personen von „Kai Spezis“");
    expect(german).toContain(
      "2 weitere Apps oder Wissensbasen, die du nicht sehen darfst, lesen Facts."
    );
    expect(german).not.toContain("Sie nicht");
    // No id of a person or a child Workflow reaches the sentence.
    expect(german).not.toMatch(/usr_|child_fetch/u);
    // A workspace name from the stored-data module cannot break the line the CLI prints.
    const hostile = (await steps("en", true)).summary;
    expect(hostile).not.toMatch(/[\n\r]/u);
    expect(hostile).toContain("“Kai Nachtimport sends nothing.”");
  });

  it("says admins alone have access only where every grant was read, and never nobody", async () => {
    const config = nightlyImport();
    const manifest = config.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error();
    const steps = Array.isArray(manifest.steps) ? manifest.steps.slice(0, 4) : [];
    const workflow = (locale: LocaleCode, truncated: boolean) =>
      narrateWorkflow(
        locale,
        {
          stored: {
            ...storedData,
            storeReaders: (_access, stores) =>
              Promise.resolve(
                stores.map((store) => ({
                  store,
                  title: "Findings",
                  readers: [
                    {
                      kind: APP,
                      title: "Leer",
                      audience: { workspace: { title: "Leer", members: 0 }, holders: 0 }
                    }
                  ],
                  hidden: 0,
                  truncated
                }))
              )
          }
        },
        { ...config, manifest: { ...manifest, steps } }
      );
    const app = (locale: LocaleCode, truncated: boolean) =>
      narrator({
        stored: {
          ...storedData,
          appRevision: () => Promise.resolve({ audience: { holders: 0 }, stores: [], truncated })
        }
      }).narrate({
        kind: "app",
        name: "findings",
        scope: workspaceScope,
        revision: 2,
        config: { title: "Findings", manifest: { actions: [] } },
        locale,
        access: everything
      });

    // Complete: admins alone hold it, by their role.
    const complete = (await workflow("en", false)).summary;
    expect(complete).toContain(
      "The App “Leer” shows the rows of Findings to instance admins only."
    );
    expect(complete).not.toMatch(/nobody|may omit/u);
    expect((await workflow("de", false)).summary).toContain(
      "Die App „Leer“ zeigt die Zeilen von Findings nur Instanz-Admins."
    );
    expect((await app("en", false))?.summary).toBe(
      "Findings opens for instance admins only. It changes nothing."
    );
    expect((await app("de", false))?.summary).toBe(
      "Findings öffnet sich nur für Instanz-Admins. Sie ändert nichts."
    );

    // Incomplete: a grant past the bound may give more access; "only" would be false.
    const incomplete = (await workflow("en", true)).summary;
    expect(incomplete).toContain(
      "The App “Leer” shows the rows of Findings to instance admins and possibly others."
    );
    expect(incomplete).toContain("This review may omit other readers of Findings.");
    expect(incomplete).not.toMatch(/only|nobody|No App or knowledge base reads/u);
    const german = (await workflow("de", true)).summary;
    expect(german).toContain(
      "Die App „Leer“ zeigt die Zeilen von Findings Instanz-Admins und möglicherweise weiteren."
    );
    expect(german).toContain("Diese Übersicht nennt vielleicht nicht alle Leser von Findings.");
    expect(german).not.toContain("nur Instanz-Admins");
    expect((await app("en", true))?.summary).toBe(
      "Findings opens for instance admins and possibly others. It changes nothing. This review may omit other people or data sources."
    );
    const germanApp = (await app("de", true))?.summary;
    expect(germanApp).toContain(
      "Findings öffnet sich für Instanz-Admins und möglicherweise weitere."
    );
    expect(germanApp).toContain(
      "Diese Übersicht nennt vielleicht nicht alle Personen und Datenquellen."
    );
    expect(germanApp).not.toContain("nur");
  });

  it("counts holders of their own right apart from the workspace's people, in plain words", async () => {
    const narrate = (locale: LocaleCode, holders: number) =>
      narrator({
        stored: {
          ...storedData,
          appRevision: () =>
            Promise.resolve({
              audience: { workspace: { title: "Kai Spezis", members: 14 }, holders },
              stores: [],
              truncated: false
            })
        }
      }).narrate({
        kind: "app",
        name: "findings",
        scope: workspaceScope,
        revision: 2,
        config: { title: "Findings", manifest: { actions: [] } },
        locale,
        access: everything
      });
    expect((await narrate("en", 2))?.summary).toContain(
      "Findings opens for the 14 people of “Kai Spezis” and 2 holders with their own right."
    );
    expect((await narrate("en", 1))?.summary).toContain("and one holder with its own right.");
    expect((await narrate("de", 2))?.summary).toContain(
      "Findings öffnet sich für die 14 Personen von „Kai Spezis“ und 2 weitere mit eigenem Recht."
    );
    for (const locale of ["en", "de"] as const) {
      expect((await narrate(locale, 2))?.summary).not.toMatch(/grant|Berechtigung/iu);
    }
  });

  it("narrates an App without the stored-data module by its workspace, and nothing for another kind", async () => {
    const english: LocaleCode = "en";
    const plain = createPublishNarrator({
      clientInstanceId,
      stores: {
        configAssets: { getConfigAsset: () => Promise.resolve(undefined) },
        workspaces: { getWorkspace: () => Promise.resolve({ name: "Kai Spezis" }) },
        users: { getUser: () => Promise.resolve(undefined) }
      },
      resolve: () => Promise.resolve(undefined)
    });
    const input = {
      name: "findings",
      scope: workspaceScope,
      revision: 1,
      config: { title: "Findings", manifest: { actions: [] } },
      locale: english,
      access: everything
    };
    expect((await plain.narrate({ ...input, kind: "app" }))?.summary).toBe(
      "Findings opens for whoever may use it in “Kai Spezis”. It changes nothing."
    );
    expect(await plain.narrate({ ...input, kind: "skill" })).toBeUndefined();
  });
});
