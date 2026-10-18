import { describe, expect, it, vi } from "vitest";

import {
  asCollaborationWorkspaceId,
  INSTANCE_ASSET_SCOPE,
  type AssetScope,
  type JsonObject,
  type LocaleCode
} from "@work-shape/catalyst-core";

import { createPublishNarrator } from "@work-shape/catalyst-server";

import {
  clientInstanceId,
  WORKSPACE,
  workspaceScope,
  everything,
  nothing,
  operationDefinition,
  nightlyImport,
  APP,
  storedData,
  ibanApproval,
  narrator,
  narrateWorkflow
} from "./support/publish-narrative";

// PUBQ-1: the publish question leads with one generated sentence of what runs, when, as which
// account, what it reads, writes and sends and who sees it, and warns before the click of each
// step a guardrail in force will stop under WF-AUTO-1. The sentence names and counts; it never
// runs a step, calls a model, records a hit, or reads a row.

describe("PUBQ-1 the publish question's sentence", () => {
  it("check 75: names the schedule, the account, Exampledata, Findings, the mail and the App's audience, and warns of the mail step before the click", async () => {
    const narrative = await narrateWorkflow("en");
    expect(narrative.summary).toBe(
      "Nachtimport runs as the account “nachtimport-runner” every day at 2:00 AM (UTC, the default time zone), reads from Exampledata, adds rows to Findings, and uses Outlook for “Mail an Mandanten”. The App “Findings” shows the rows of Findings to the 14 people of “Kai Spezis”."
    );
    expect(narrative.warnings).toEqual([
      "The step “Mail an Mandanten” may stop: the guardrail “E-Mail senden: IBAN → Freigabe” asks for approval when what it checks matches, and a published run cannot wait for one."
    ]);
  });

  it("check 75 in German: the same sentence and warning in the reader's language", async () => {
    const narrative = await narrateWorkflow("de");
    expect(narrative.summary).toBe(
      "Nachtimport läuft jeden Tag um 02:00 Uhr (UTC, die Standardzeitzone) unter dem Konto „nachtimport-runner“, liest aus Exampledata, fügt Zeilen in Findings hinzu und nutzt Outlook für „Mail an Mandanten“. Die App „Findings“ zeigt den 14 Personen von „Kai Spezis“ die Zeilen von Findings."
    );
    expect(narrative.warnings).toEqual([
      "Der Schritt „Mail an Mandanten“ kann angehalten werden: Die Leitplanke „E-Mail senden: IBAN → Freigabe“ verlangt eine Freigabe, wenn ihre Prüfung einen Treffer ergibt, und ein veröffentlichter Lauf kann nicht auf sie warten."
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

  it.each([{ operation: "workflow.*" }, { origin: "workflow" as const }])(
    "warns on child Workflow starts for filter %j",
    async (filter) => {
      const result = await narrateWorkflow(
        "en",
        {
          guardrails: [
            { guardrail: { ...ibanApproval, filter, check: { kind: "pattern", pattern: "." } } }
          ]
        },
        {
          manifest: {
            name: "Parent",
            steps: [
              { id: "start", type: "trigger", triggers: [{ kind: "manual" }] },
              {
                id: "child",
                name: "Fetch child",
                type: "workflow",
                workflow: "child_fetch",
                input: {}
              }
            ]
          }
        }
      );
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Fetch child");
      expect(result.warnings[0]).toContain("will stop");
    }
  );

  it("uses a workspace store's resource for an instance Workflow, and never a Workflow workspace for a Connection", async () => {
    const review = narrator({
      guardrails: [
        {
          guardrail: {
            ...ibanApproval,
            filter: { origin: "workflow" },
            check: { kind: "pattern", pattern: "." }
          },
          scope: workspaceScope
        }
      ]
    });
    const run = (scope: AssetScope) =>
      review.narrate({
        kind: "workflow",
        name: "nightly",
        scope,
        revision: 1,
        config: nightlyImport(),
        locale: "en",
        access: everything
      });
    for (const scope of [INSTANCE_ASSET_SCOPE, workspaceScope]) {
      const result = await run(scope);
      expect(result?.warnings).toHaveLength(1);
      expect(result?.warnings[0]).toContain("Befunde speichern");
      expect(result?.warnings.join(" ")).not.toContain("Mail an Mandanten");
    }
  });

  it("evaluates a literal pattern with runtime semantics and keeps reference-dependent warnings conditional", async () => {
    const config = (to: JsonObject) => ({
      manifest: {
        name: "Mailer",
        steps: [
          {
            id: "mail",
            name: "Mail",
            type: "operation",
            operation: "connection.outlook.send_mail",
            input: { to }
          }
        ]
      }
    });
    const options = {
      guardrails: [
        { guardrail: { ...ibanApproval, check: { kind: "pattern" as const, pattern: "IBAN" } } }
      ]
    };
    expect(
      (await narrateWorkflow("en", options, config({ value: "no account" }))).warnings
    ).toEqual([]);
    expect((await narrateWorkflow("en", options, config({ value: "IBAN" }))).warnings[0]).toContain(
      "will stop"
    );
    expect(
      (await narrateWorkflow("en", options, config({ ref: { step: "previous" } }))).warnings[0]
    ).toContain("may stop");
  });

  it("previews a model judge conditionally without a model call or a recorded hit", async () => {
    const onModel = vi.fn();
    const onHit = vi.fn();
    const result = await narrateWorkflow("en", {
      onModel,
      onHit,
      guardrails: [
        {
          guardrail: {
            ...ibanApproval,
            check: { kind: "model_judge", modelBindingId: "judge", instruction: "Review the mail." }
          }
        }
      ]
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("may stop");
    expect(onModel).not.toHaveBeenCalled();
    expect(onHit).not.toHaveBeenCalled();
  });

  it("asks operation-owned before-events with the runtime's subject filter", async () => {
    const operation = "connection.outlook.send_mail";
    const result = await narrateWorkflow("en", {
      definitions: [
        {
          ...operationDefinition(operation),
          beforeEvents: () => [
            {
              name: "asset.before_write",
              subject: { kind: "app", id: "offers" },
              checkable: () => ({ content: "review" })
            }
          ]
        }
      ],
      guardrails: [
        {
          guardrail: {
            ...ibanApproval,
            on: "asset.before_write",
            filter: { kind: "app" },
            check: { kind: "pattern", pattern: "." }
          }
        }
      ]
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Mail an Mandanten");
  });

  it.each(["central_setting", "policy_floor"] as const)(
    "names approval from %s through the runtime policy evaluation",
    async (source) => {
      const operation = "connection.outlook.send_mail";
      const result = await narrateWorkflow("en", {
        definitions: [
          {
            ...operationDefinition(operation),
            ...(source === "policy_floor" ? { policyFloor: "confirm" as const } : {})
          }
        ],
        policy: {
          instanceDefaults: { reading: "allow", changing: "confirm" },
          centralSettings: () =>
            source === "central_setting" ? [{ operation, value: "approval" }] : []
        }
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Mail an Mandanten");
      expect(result.warnings[0]).toContain(
        source === "central_setting" ? "instance policy" : "operation’s minimum policy"
      );
    }
  );

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
      "Nachtimport runs as the account “nachtimport-runner” every day at 2:00 AM (UTC, the default time zone), reads from Exampledata, adds rows to Findings, and sends nothing. 2 more Apps or knowledge bases you may not see read Findings."
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
    expect(narrative.summary).toContain(
      "runs as the account “nachtimport-runner” when someone starts it and uses Exampledata"
    );
    expect(narrative.summary).toContain("uses Exampledata for “Archivieren”");
    expect(narrative.summary).not.toContain("sends nothing");
  });

  it("sets a started-by-hand clause apart from the account, and writes clock times per locale", async () => {
    const config = nightlyImport();
    const manifest = config.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error();
    const archive = {
      id: "x",
      name: "Archivieren",
      type: "operation",
      operation: "connection.exampledata.archive",
      input: {}
    };
    const manual = (runAs: boolean, trigger: JsonObject = { kind: "manual" }) => {
      const kept = Object.entries(manifest).filter(([key]) => runAs || key !== "runAs");
      return {
        ...config,
        manifest: {
          ...Object.fromEntries(kept),
          steps: [{ id: "start", name: "Start", type: "trigger", triggers: [trigger] }, archive]
        }
      };
    };
    const summary = async (locale: LocaleCode, input: JsonObject) =>
      (await narrateWorkflow(locale, {}, input)).summary;

    expect(await summary("en", manual(true))).toBe(
      "Nachtimport runs as the account “nachtimport-runner” when someone starts it and uses Exampledata for “Archivieren”."
    );
    expect(await summary("de", manual(true))).toBe(
      "Nachtimport läuft, wenn jemand ihn startet, unter dem Konto „nachtimport-runner“ und nutzt Exampledata für „Archivieren“."
    );
    // Without an account the clause still closes before "und".
    expect(await summary("de", manual(false))).toBe(
      "Nachtimport läuft, wenn jemand ihn startet, und nutzt Exampledata für „Archivieren“."
    );
    expect(await summary("en", manual(false))).toBe(
      "Nachtimport runs when someone starts it and uses Exampledata for “Archivieren”."
    );
    const evening = { kind: "schedule", cron: "30 18 * * 1" };
    expect(await summary("en", manual(true, evening))).toContain(
      "runs as the account “nachtimport-runner” every Monday at 6:30 PM (UTC, the default time zone) and uses"
    );
    expect(await summary("de", manual(true, evening))).toContain(
      "läuft jeden Montag um 18:30 Uhr (UTC, die Standardzeitzone) unter dem Konto „nachtimport-runner“ und nutzt"
    );
  });

  it("E1: names the zone of a schedule's clock time and never says the cron itself", async () => {
    const config = nightlyImport();
    const manifest = config.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error();
    const scheduled = (trigger: JsonObject) => ({
      ...config,
      manifest: {
        ...manifest,
        steps: [{ id: "start", name: "Start", type: "trigger", triggers: [trigger] }]
      }
    });
    const summary = async (
      locale: LocaleCode,
      trigger: JsonObject,
      timeZone?: string
    ): Promise<string> =>
      (
        await narrateWorkflow(
          locale,
          timeZone === undefined ? {} : { timeZone },
          scheduled({ kind: "schedule", ...trigger })
        )
      ).summary;

    // The trigger's own zone wins over the instance's; 23:25 stays 23:25, never converted.
    expect(
      await summary("de", { cron: "25 23 * * *", timeZone: "Europe/Berlin" }, "America/New_York")
    ).toContain("läuft jeden Tag um 23:25 Uhr (Europe/Berlin) unter dem Konto");
    // Without one, the instance's zone.
    expect(await summary("en", { cron: "25 23 * * *" }, "Europe/Berlin")).toContain(
      "every day at 11:25 PM (Europe/Berlin)"
    );
    // Without either, UTC, said as the default.
    expect(await summary("de", { cron: "25 23 * * *" })).toContain(
      "jeden Tag um 23:25 Uhr (UTC, die Standardzeitzone)"
    );
    // A fixed day of a fixed month reads as a date, never as the cron.
    const once = { cron: "34 21 18 10 *", timeZone: "Europe/Berlin" };
    expect(await summary("de", once)).toContain(
      "läuft jedes Jahr am 18. Oktober um 21:34 Uhr (Europe/Berlin)"
    );
    expect(await summary("en", once)).toContain(
      "every year on October 18 at 9:34 PM (Europe/Berlin)"
    );
    // A form not put into words is a plain schedule with its zone; no date that does not exist.
    for (const cron of ["*/5 * * * *", "0 9 31 2 *", "0 9 1-5 * *"]) {
      const de = await summary("de", { cron, timeZone: "Europe/Berlin" });
      expect(de).toContain("läuft nach Zeitplan (Europe/Berlin) unter dem Konto");
      expect(de).not.toContain(cron);
      expect(await summary("en", { cron })).toContain(
        "runs as the account “nachtimport-runner” on a schedule (UTC, the default time zone)"
      );
    }
  });

  it("names holders alone in the case the sentence asks for, and never as others", async () => {
    const narrate = (locale: LocaleCode, holders: number) =>
      narrator({
        stored: {
          ...storedData,
          appRevision: () =>
            Promise.resolve({ audience: { holders }, stores: [], truncated: false })
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
    expect((await narrate("de", 1))?.summary).toBe(
      "Findings öffnet sich für einen Inhaber mit eigenem Recht. Sie ändert nichts."
    );
    expect((await narrate("de", 3))?.summary).toBe(
      "Findings öffnet sich für 3 Inhaber mit eigenem Recht. Sie ändert nichts."
    );
    expect((await narrate("en", 1))?.summary).toBe(
      "Findings opens for one holder with its own right. It changes nothing."
    );
    for (const holders of [1, 3]) {
      expect((await narrate("de", holders))?.summary).not.toMatch(/weitere/u);
    }
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
      "Die App „Leer“ zeigt nur Instanz-Admins die Zeilen von Findings."
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
      "Die App „Leer“ zeigt Instanz-Admins und möglicherweise weiteren die Zeilen von Findings."
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
      "Findings öffnet sich für die 14 Personen von „Kai Spezis“ und 2 weitere Inhaber mit eigenem Recht."
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

  it("names the chosen audience mid-sentence in lower case, without doubling German “für”", async () => {
    const plain = createPublishNarrator({
      clientInstanceId,
      stores: {
        configAssets: { getConfigAsset: () => Promise.resolve(undefined) },
        workspaces: { getWorkspace: () => Promise.resolve({ name: "Vertrieb" }) },
        users: { getUser: () => Promise.resolve(undefined) }
      },
      resolve: () => Promise.resolve(undefined)
    });
    const summary = async (locale: LocaleCode, audienceLabel: string) =>
      (
        await plain.narrate({
          kind: "app",
          name: "findings",
          scope: workspaceScope,
          revision: 1,
          config: { title: "Findings", manifest: { actions: [] } },
          locale,
          access: everything,
          audienceLabel
        })
      )?.summary;
    expect(await summary("en", "Only the builder")).toMatch(
      /^Findings opens for only the builder\./u
    );
    expect(await summary("en", "Everyone in Sales")).toMatch(
      /^Findings opens for everyone in Sales\./u
    );
    expect(await summary("en", "Everyone in the instance")).toMatch(
      /^Findings opens for everyone in the instance\./u
    );
    expect(await summary("de", "Nur für den Ersteller")).toMatch(
      /^Findings öffnet sich nur für den Ersteller\./u
    );
    expect(await summary("de", "Alle in Vertrieb")).toMatch(
      /^Findings öffnet sich für alle in Vertrieb\./u
    );
    expect(await summary("de", "Alle in der Instanz")).toMatch(
      /^Findings öffnet sich für alle in der Instanz\./u
    );
  });
});
