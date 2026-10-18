import type { LocaleCode } from "@work-shape/catalyst-api-client";
import type { JsonObject, WorkflowManifest, WorkflowStep } from "@work-shape/catalyst-core";
import { OPERATION_EFFECTS } from "@work-shape/catalyst-core";

// Sample Workflows in the file form of the contract, for the samples page, the pictures and
// the browser tests. They are data of a development page and no part of the product.

type Words = Record<LocaleCode, string>;

const say = (locale: LocaleCode, words: Words) => words[locale];

const OBJECT: JsonObject = { type: "object" };

/**
 * What the read of a definition says of an operation step beside the file: whether it reads or
 * changes, what it works on and the `service` of its Connection. Contract need C8.
 */
interface StepReading {
  effect: (typeof OPERATION_EFFECTS)[number];
  source: string;
  service?: string;
}

export interface SampleWorkflow {
  manifest: WorkflowManifest;
  readings: Readonly<Record<string, StepReading>>;
}

const BOOKINGS: StepReading = {
  effect: "reading",
  source: "Bookings",
  service: "accounting-source"
};

function trigger(locale: LocaleCode, cron?: string): WorkflowStep {
  return {
    id: "start",
    type: "trigger",
    name: say(locale, { en: "Start", de: "Start" }),
    triggers:
      cron === undefined ? [{ kind: "manual" }] : [{ kind: "schedule", cron }, { kind: "manual" }]
  };
}

/** The loop over the clients, as `01-read` shows it. */
function clientLoop(locale: LocaleCode): WorkflowStep {
  return {
    id: "each_client",
    type: "loop",
    name: say(locale, { en: "For each client", de: "Für jeden Mandanten" }),
    items: { step: "clients", path: "items" },
    itemName: say(locale, { en: "client", de: "Mandanten" }),
    itemLabel: "name",
    onItemFailure: "continue",
    concurrency: 8,
    steps: [
      {
        id: "bookings",
        type: "operation",
        name: say(locale, { en: "Load the bookings", de: "Buchungen laden" }),
        description: say(locale, {
          en: "Fetches the bookings of the month before.",
          de: "Holt die Buchungen des Vormonats."
        }),
        operation: "connection.bookings.list_bookings",
        input: { client: { ref: { step: "each_client", path: "number" } } }
      },
      {
        id: "check",
        type: "code",
        name: say(locale, { en: "Check the bookings", de: "Buchungen prüfen" }),
        description: say(locale, {
          en: "Checks every booking against twelve rules.",
          de: "Prüft jede Buchung gegen zwölf Regeln."
        }),
        file: "check.ts",
        input: { bookings: { ref: { step: "bookings", path: "items" } } },
        inputSchema: OBJECT,
        outputSchema: OBJECT
      },
      {
        id: "save",
        type: "operation",
        name: say(locale, { en: "Save the findings", de: "Auffälligkeiten speichern" }),
        description: say(locale, { en: "Writes what stands out.", de: "Schreibt, was auffällt." }),
        operation: "data_store.findings.insert",
        input: { rows: { ref: { step: "check", path: "findings" } } }
      }
    ]
  };
}

function loadClients(locale: LocaleCode): WorkflowStep {
  return {
    id: "clients",
    type: "operation",
    name: say(locale, { en: "Load the clients", de: "Mandanten laden" }),
    description: say(locale, {
      en: "Fetches the list of every active client.",
      de: "Holt die Liste aller aktiven Mandanten."
    }),
    operation: "connection.bookings.list_clients",
    input: {}
  };
}

const LOOP_READINGS: Readonly<Record<string, StepReading>> = {
  clients: BOOKINGS,
  bookings: BOOKINGS,
  save: { effect: "changing", source: "Findings" }
};

function base(locale: LocaleCode, id: string, name: Words, description: Words) {
  return {
    id,
    name: say(locale, name),
    description: say(locale, description),
    runAs: "workflow-runner",
    inputs: OBJECT,
    outputs: OBJECT
  };
}

/** "Monthly booking check": the Workflow of the mockups. */
function monthlyCheck(locale: LocaleCode): SampleWorkflow {
  return {
    manifest: {
      ...base(
        locale,
        "monthly-booking-check",
        { en: "Monthly booking check", de: "Monatliche Buchungsprüfung" },
        {
          en: "Checks the bookings of every client each month and keeps what stands out.",
          de: "Prüft jeden Monat die Buchungen aller Mandanten und hält fest, was auffällt."
        }
      ),
      steps: [
        trigger(locale, "0 6 1 * *"),
        loadClients(locale),
        clientLoop(locale),
        {
          id: "summary",
          type: "agent",
          name: say(locale, { en: "Write the summary", de: "Zusammenfassung schreiben" }),
          description: say(locale, {
            en: "Sums up the findings for the tax team.",
            de: "Fasst die Auffälligkeiten für das Steuerteam zusammen."
          }),
          instructions: "summary.md",
          input: { counts: { ref: { step: "each_client", path: "" } } },
          inputSchema: OBJECT,
          outputSchema: OBJECT
        },
        {
          id: "result",
          type: "output",
          name: say(locale, {
            en: "Clients checked and findings",
            de: "Geprüfte Mandanten und Auffälligkeiten"
          }),
          input: { summary: { ref: { step: "summary", path: "text" } } }
        }
      ]
    },
    readings: LOOP_READINGS
  };
}

/**
 * A Workflow with every structure: a loop, a condition with two paths, a parallel block and a
 * step that starts another Workflow. No engine runs `condition` and `parallel` yet.
 */
function quarterClose(locale: LocaleCode): SampleWorkflow {
  return {
    manifest: {
      ...base(
        locale,
        "quarter-close",
        { en: "Quarter close", de: "Quartalsabschluss" },
        {
          en: "Checks every client, then reminds the ones with open findings and files the rest.",
          de: "Prüft jeden Mandanten, erinnert die mit offenen Auffälligkeiten und legt den Rest ab."
        }
      ),
      steps: [
        trigger(locale, "30 7 * * 1"),
        loadClients(locale),
        clientLoop(locale),
        {
          id: "any_findings",
          type: "condition",
          name: say(locale, { en: "Any findings?", de: "Gibt es Auffälligkeiten?" }),
          description: say(locale, {
            en: "Looks whether a client has open findings.",
            de: "Schaut, ob ein Mandant offene Auffälligkeiten hat."
          }),
          when: { ref: { step: "each_client", path: "failed" }, op: "greater_than", value: 0 },
          then: [
            {
              id: "at_once",
              type: "parallel",
              name: say(locale, { en: "At the same time", de: "Gleichzeitig" }),
              branches: [
                {
                  id: "team",
                  name: say(locale, { en: "Tax team", de: "Steuerteam" }),
                  steps: [
                    {
                      id: "tell_team",
                      type: "notify",
                      name: say(locale, { en: "Tell the tax team", de: "Steuerteam informieren" }),
                      description: say(locale, {
                        en: "Puts the list of findings in the team's Inbox.",
                        de: "Legt die Liste der Auffälligkeiten in die Inbox des Teams."
                      }),
                      to: { users: ["sample-reviewer"] },
                      channels: ["inbox"],
                      title: { value: "Review ready" },
                      text: { value: "Open the run to review its findings." }
                    }
                  ]
                },
                {
                  id: "clients",
                  name: say(locale, { en: "Clients", de: "Mandanten" }),
                  steps: [
                    {
                      id: "remind",
                      type: "workflow",
                      name: say(locale, { en: "Send reminders", de: "Erinnerungen senden" }),
                      description: say(locale, {
                        en: "Reminds every client with open findings.",
                        de: "Erinnert jeden Mandanten mit offenen Auffälligkeiten."
                      }),
                      workflow: "send-reminders",
                      input: {}
                    }
                  ]
                }
              ]
            }
          ],
          else: [
            {
              id: "file",
              type: "operation",
              name: say(locale, { en: "File the quarter", de: "Quartal ablegen" }),
              description: say(locale, {
                en: "Marks the quarter as checked without findings.",
                de: "Markiert das Quartal als ohne Auffälligkeiten geprüft."
              }),
              operation: "data_store.quarters.insert",
              input: {}
            }
          ]
        },
        {
          id: "result",
          type: "output",
          name: say(locale, { en: "Quarter closed", de: "Quartal abgeschlossen" }),
          input: {}
        }
      ]
    },
    readings: { ...LOOP_READINGS, file: { effect: "changing", source: "Quarters" } }
  };
}

/** The Workflow a step of "Quarter close" starts. */
function sendReminders(locale: LocaleCode): SampleWorkflow {
  return {
    manifest: {
      ...base(
        locale,
        "send-reminders",
        { en: "Send reminders", de: "Erinnerungen senden" },
        {
          en: "Writes to every client with open findings.",
          de: "Schreibt jedem Mandanten mit offenen Auffälligkeiten."
        }
      ),
      steps: [
        {
          id: "start",
          type: "trigger",
          name: say(locale, { en: "Start", de: "Start" }),
          triggers: [{ kind: "parent" }, { kind: "manual" }]
        },
        {
          id: "open_findings",
          type: "operation",
          name: say(locale, { en: "Load the open findings", de: "Offene Auffälligkeiten laden" }),
          description: say(locale, {
            en: "Reads the findings nobody has answered.",
            de: "Liest die Auffälligkeiten, auf die niemand geantwortet hat."
          }),
          operation: "data_store.findings.query",
          input: {}
        },
        {
          id: "mail",
          type: "notify",
          name: say(locale, { en: "Write to the client", de: "Mandanten anschreiben" }),
          description: say(locale, {
            en: "Sends a notice count and an Inbox link to the reviewer.",
            de: "Sendet eine Mitteilungsanzahl und einen Inbox-Link an die prüfende Person."
          }),
          to: { users: ["sample-reviewer"] },
          channels: ["inbox", "mail"],
          title: { value: "Review ready" },
          text: { value: "Open the run to review what is pending." }
        },
        {
          id: "result",
          type: "output",
          name: say(locale, { en: "Reminders sent", de: "Erinnerungen gesendet" }),
          input: {}
        }
      ]
    },
    readings: { open_findings: { effect: "reading", source: "Findings" } }
  };
}

/** A Workflow without a step: what a builder has just created. */
function emptyDraft(locale: LocaleCode): SampleWorkflow {
  return {
    manifest: {
      ...base(
        locale,
        "new-workflow",
        { en: "New workflow", de: "Neuer Workflow" },
        { en: "Nothing here yet.", de: "Noch nichts hier." }
      ),
      steps: []
    },
    readings: {}
  };
}

/** The sample Workflows in one language, in the order of the list. */
export function sampleWorkflows(locale: LocaleCode): readonly SampleWorkflow[] {
  return [monthlyCheck(locale), quarterClose(locale), sendReminders(locale), emptyDraft(locale)];
}
