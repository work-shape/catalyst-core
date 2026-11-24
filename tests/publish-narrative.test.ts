import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asCollaborationWorkspaceId,
  asUserId,
  INSTANCE_ASSET_SCOPE,
  type AssetScope,
  type CollaborationWorkspace,
  type JsonObject,
  type LocaleCode,
  type OperationDefinition,
  type PublishNarrativeStoredData
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
      await summary("en", { cron: "25 23 * * *", timeZone: "Europe/Berlin" }, "America/New_York")
    ).toContain("every day at 11:25 PM (Europe/Berlin)");
    // Without one, the instance's zone; without either, UTC.
    expect(await summary("en", { cron: "25 23 * * *" }, "Europe/Berlin")).toContain(
      "(Europe/Berlin)"
    );
    expect(await summary("en", { cron: "25 23 * * *" })).toContain("(UTC, the default time zone)");
    // A form not put into words is a plain schedule with its zone, never the cron.
    for (const cron of ["*/5 * * * *", "0 9 31 2 *"]) {
      const text = await summary("en", { cron });
      expect(text).toContain("on a schedule (UTC, the default time zone)");
      expect(text).not.toContain(cron);
    }
  });

  it.each([
    ["en", "instance", "everyone in the instance"],
    ["de", "self", "die Person, mit der sie geteilt ist"]
  ] as const)(
    "ACCEPT-FIX-11 E-2: %s names the published %s audience instead of ownership",
    async (locale, audience, expected) => {
      const narrative = await narrator({
        stored: {
          ...storedData,
          appRevision: () =>
            Promise.resolve({
              audience: { app: { audience, people: 2 }, holders: 0 },
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
      expect(narrative?.summary).toContain(expected);
      expect(narrative?.summary).not.toMatch(/admins only|nur Instanz-Admins|Personal workspace/u);
    }
  );

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
    const narrative = await narrator({}).narrate({
      kind: "app",
      name: "findings",
      scope: workspaceScope,
      revision: 2,
      config,
      locale: "en",
      access: everything
    });
    expect(narrative).toEqual({
      summary:
        "Findings opens for the 14 people of “Kai Spezis”. Everyone who opens it sees what its actions read from Findings (copied by Nachtimport from Exampledata). Its actions use Outlook for “send_reminder”.",
      warnings: []
    });
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
    // No id of a person or a child Workflow reaches the sentence.
    expect((await steps("en")).summary).not.toMatch(/usr_|child_fetch/u);
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
    const workflow = (truncated: boolean) =>
      narrateWorkflow(
        "en",
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
    const app = (truncated: boolean) =>
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
        locale: "en",
        access: everything
      });

    // Complete: admins alone hold it, by their role.
    const complete = (await workflow(false)).summary;
    expect(complete).toContain(
      "The App “Leer” shows the rows of Findings to instance admins only."
    );
    expect(complete).not.toMatch(/nobody|may omit/u);
    expect((await app(false))?.summary).toBe(
      "Findings opens for instance admins only. It changes nothing."
    );

    // Incomplete: a grant past the bound may give more access; "only" would be false.
    const incomplete = (await workflow(true)).summary;
    expect(incomplete).toContain(
      "The App “Leer” shows the rows of Findings to instance admins and possibly others."
    );
    expect(incomplete).toContain("This review may omit other readers of Findings.");
    expect(incomplete).not.toMatch(/only|nobody|No App or knowledge base reads/u);
    expect((await app(true))?.summary).toBe(
      "Findings opens for instance admins and possibly others. It changes nothing. This review may omit other people or data sources."
    );
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

describe("MAIL-2 a mail step in the publish question (check 139)", () => {
  const sender = { name: "Kanzlei Muster", address: "catalyst@mail.example.test" };
  const mailer = (steps: JsonObject[]): JsonObject => ({
    title: "Monatsmail",
    manifest: {
      id: "monatsmail",
      name: "Monatsmail",
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        ...steps
      ]
    }
  });
  const mail = (id: string, name: string, input: JsonObject): JsonObject => ({
    id,
    name,
    type: "operation",
    operation: "mail.send",
    input: { subject: { value: "Stand" }, body: { value: "Alles gut." }, ...input }
  });
  const options = (extra: Partial<Parameters<typeof narrator>[0]> = {}) => ({
    definitions: [operationDefinition("mail.send")],
    mailSender: sender,
    ...extra
  });

  it("says whom each step mails and as which sender, and that an outside address holds no data scope", async () => {
    const config = mailer([
      mail("team", "An das Team", {
        to: { value: [{ user: "usr_anna" }, { workspace: WORKSPACE }, "office@kanzlei.de"] }
      }),
      mail("client", "An den Mandanten", {
        to: { ref: { step: "start", path: "input.email" } },
        senderName: { value: "Kanzlei Team" }
      })
    ]);
    expect((await narrateWorkflow("en", options(), config)).summary).toBe(
      "Monatsmail runs when someone starts it, e-mails Anna Berg, the workspace “Kai Spezis”, and office@kanzlei.de as “Kanzlei Muster” <catalyst@mail.example.test>, and e-mails recipients from earlier steps as “Kanzlei Team” <catalyst@mail.example.test>. An address outside the instance holds no data scope: it receives whatever the mail says."
    );
  });

  it("says nothing of outside addresses where a step mails only people and workspaces", async () => {
    // An empty copy list, which the operation takes, names nobody and reads no recipient.
    const config = mailer([
      mail("team", "An das Team", {
        to: { value: [{ user: "usr_ben" }] },
        cc: { value: [] },
        bcc: { value: [] }
      })
    ]);
    const { summary } = await narrateWorkflow("en", options(), config);
    expect(summary).toBe(
      "Monatsmail runs when someone starts it and e-mails Ben Kurz as “Kanzlei Muster” <catalyst@mail.example.test>."
    );
  });

  it("names the mail step a guardrail on mail.send will stop", async () => {
    const config = mailer([
      mail("team", "An das Team", {
        to: { value: "office@kanzlei.de" },
        body: { value: "Bitte auf DE89370400440532013000 überweisen." }
      })
    ]);
    const { warnings } = await narrateWorkflow(
      "en",
      options({
        guardrails: [{ guardrail: { ...ibanApproval, filter: { operation: "mail.send" } } }]
      }),
      config
    );
    expect(warnings).toEqual([
      expect.stringContaining(
        "The step “An das Team” will stop: the guardrail “E-Mail senden: IBAN → Freigabe”"
      )
    ]);
  });
});

describe("publish narration survives outside input checks", () => {
  const operation = "connection.outlook.send_mail";
  const checks = (count: number): JsonObject => ({
    manifest: {
      name: "Checks",
      steps: [
        { id: "start", type: "trigger", triggers: [{ kind: "manual" }] },
        ...Array.from({ length: count }, (_, index) => ({
          id: `step-${index}`,
          name: `Check ${index}`,
          type: "operation",
          operation,
          input: {}
        }))
      ]
    }
  });
  const narrateChecks = (definition: OperationDefinition, count = 1) =>
    narrator({ definitions: [definition] }).narrate({
      kind: "workflow",
      name: "checks",
      scope: workspaceScope,
      revision: 1,
      config: checks(count),
      locale: "en",
      access: everything
    });

  afterEach(() => vi.useRealTimers());

  it("names a step that may stop when its check throws, without the error", async () => {
    const result = await narrateChecks({
      ...operationDefinition(operation),
      inputSchema: z.unknown().superRefine(async () => {
        throw new Error("schema_check_timeout");
      })
    });
    expect(result?.warnings).toHaveLength(1);
    expect(result?.warnings[0]).toContain("“Check 0” may stop");
    expect(JSON.stringify(result)).not.toContain("schema_check_timeout");
    expect(Object.keys(result ?? {}).sort()).toEqual(["summary", "warnings"]);
  });

  it("warns that an input the Connection schema refuses may stop the step", async () => {
    const result = await narrateChecks({
      ...operationDefinition(operation),
      inputSchema: z.object({ required: z.string() })
    });
    expect(result?.warnings[0]).toContain("may stop");
  });

  it("bounds the whole narration when its metadata read never answers", async () => {
    vi.useFakeTimers();
    const instance = narrator({
      stored: { appRevision: () => new Promise(() => {}), storeReaders: async () => [] }
    });
    const pending = instance.narrate({
      kind: "app",
      name: "checks",
      scope: workspaceScope,
      revision: 1,
      config: { title: "Checks", manifest: { actions: [] } },
      locale: "en",
      access: everything
    });
    const failed = expect(pending).rejects.toThrow("Publish narration timed out");
    await vi.advanceTimersByTimeAsync(3_100);
    await failed;
  });

  it("returns 50 slow steps within one narration budget, including checks still queued", async () => {
    vi.useFakeTimers();
    const checked = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    });
    let settled = false;
    const started = Date.now();
    let finishedAt = started;
    const pending = narrateChecks(
      { ...operationDefinition(operation), inputSchema: z.unknown().superRefine(checked) },
      50
    ).then((result) => {
      settled = true;
      finishedAt = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(settled).toBe(true);
    const result = await pending;
    expect(finishedAt - started).toBeLessThanOrEqual(3_000);
    expect(result?.warnings).toHaveLength(50);
    expect(result?.warnings[49]).toContain("“Check 49” may stop");
    expect(checked).toHaveBeenCalledTimes(4);
    // Let the already-started checks finish: no queued check starts after the deadline.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checked).toHaveBeenCalledTimes(4);
  });

  it("checks 50 delayed steps concurrently with a small bound before the budget ends", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const checked = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      active--;
    });
    let settled = false;
    const pending = narrateChecks(
      {
        ...operationDefinition(operation),
        policyFloor: "deny",
        inputSchema: z.unknown().superRefine(checked)
      },
      50
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_400);
    expect(settled).toBe(true);
    const result = await pending;
    expect(checked).toHaveBeenCalledTimes(50);
    expect(peak).toBe(4);
    expect(result?.warnings.every((warning) => warning.includes("will be refused"))).toBe(true);
  });

  it("reads published guardrails once per narration and reads them fresh for the next", async () => {
    const onGuardrailRead = vi.fn();
    const instance = narrator({ onGuardrailRead });
    const input = {
      kind: "workflow",
      name: "checks",
      scope: workspaceScope,
      revision: 1,
      config: checks(50),
      locale: "en" as const,
      access: everything
    };
    await instance.narrate(input);
    expect(onGuardrailRead).toHaveBeenCalledTimes(1);
    await instance.narrate(input);
    expect(onGuardrailRead).toHaveBeenCalledTimes(2);
  });
});

// ACCEPT-FIX-2 C5 on the server: the publish sentence names a Personal Workspace after its
// owner, or by the generic name in the reader's language where no name of the owner can be
// read. The name stored on its row, "Personal workspace", is never written.
describe("the publish sentence of an App in a Personal Workspace", () => {
  const STORED = "Personal workspace";
  const MARA = asCollaborationWorkspaceId("cw_mara");
  const MAILBOX = asCollaborationWorkspaceId("cw_mailbox");
  const WORKSPACES: Record<
    string,
    Pick<CollaborationWorkspace, "name" | "kind" | "personalUserId">
  > = {
    [MARA]: { name: STORED, kind: "personal", personalUserId: asUserId("usr_mara") },
    // An account without a name has its e-mail address as its label.
    [MAILBOX]: { name: STORED, kind: "personal", personalUserId: asUserId("usr_mailbox") }
  };
  const PEOPLE: Record<string, string> = {
    usr_mara: "Mara Lindqvist",
    usr_mailbox: "inbox@example.test"
  };
  async function appSentence(
    workspaceId: CollaborationWorkspace["id"],
    locale: LocaleCode,
    storedData?: PublishNarrativeStoredData
  ): Promise<string> {
    const narrative = await createPublishNarrator({
      clientInstanceId,
      stores: {
        configAssets: { getConfigAsset: () => Promise.resolve(undefined) },
        workspaces: { getWorkspace: (_instance, id) => Promise.resolve(WORKSPACES[id]) },
        users: {
          getUser: ({ userId }) => {
            const displayLabel = PEOPLE[userId];
            return Promise.resolve(displayLabel === undefined ? undefined : { displayLabel });
          }
        }
      },
      resolve: () => Promise.resolve(undefined),
      ...(storedData ? { storedData } : {})
    }).narrate({
      kind: "app",
      name: "urlaub",
      scope: { kind: "workspace", workspaceId },
      revision: 1,
      config: { title: "Urlaubsanträge", manifest: { actions: [] } },
      locale,
      access: everything
    });
    if (!narrative) throw new Error("An App revision is narrated");
    return narrative.summary;
  }

  it("names the workspace after its owner, or generically where the owner has no name", async () => {
    expect(await appSentence(MARA, "en")).toContain("“Mara's workspace”");
    expect(await appSentence(MAILBOX, "de")).toContain("„Persönlicher Arbeitsbereich“");
    expect(await appSentence(MAILBOX, "de")).not.toContain(STORED);
  });

  it("names the people who use it by the owner's workspace, not the stored name", async () => {
    const stored: PublishNarrativeStoredData = {
      // The stored-data module reads the name stored on the row.
      appRevision: () =>
        Promise.resolve({
          audience: { workspace: { title: STORED, members: 1 }, holders: 0 },
          stores: [],
          truncated: false
        }),
      storeReaders: () => Promise.resolve([])
    };
    const english = await appSentence(MARA, "en", stored);
    expect(english).toContain("“Mara's workspace”");
    expect(english).not.toContain(STORED);
  });
});
