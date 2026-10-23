import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError, type AgentRunProjection } from "@work-shape/catalyst-api-client";
import { DECISION_EXPIRED_REASON } from "@work-shape/catalyst-core";
import {
  readToolDisplayProjection,
  ToolCallPart,
  ToolDecisionsProvider
} from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import {
  ToolDecisionCardView,
  type ToolDecisionAnswer
} from "@work-shape/catalyst-chat-ui/tool-decision-card";
import {
  readToolDecisions,
  toolDecisionFailure,
  toolDecisionInputRows,
  type ToolDecision
} from "@work-shape/catalyst-chat-ui/tool-decision-model";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { workspaceQueryKeys } from "./support/chat-ui";

// EW-2b: an agent's call under `confirm` pauses its run, and the conversation shows the host's
// own card on that call: what it is, its input as it will run, when it expires, Allow and Deny
// with an optional reason. Once answered, the card says what became of the call.

const TOOL = "connection.sample-business.create_offer";

const requested = {
  operationRunId: "oprun_1",
  operationId: "connections.sample-business.create_offer",
  mode: "confirm" as const,
  inputPreview: { customer: "Müller GmbH", offer: { amount: 1200, currency: "EUR" } },
  expiresAt: "2026-10-16T18:30:00Z"
};
const waiting: ToolDecision = { ...requested, toolCallId: "call_1" };

const idle: ToolDecisionAnswer = {
  decide: () => undefined,
  pending: false,
  decided: undefined,
  failure: undefined
};

function inLocale(locale: "en" | "de", node: ReactNode): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { children: node, locale }));
}

function renderView(
  decision: ToolDecision,
  answer: Partial<ToolDecisionAnswer> = {},
  locale: "en" | "de" = "en"
): string {
  return inLocale(
    locale,
    createElement(ToolDecisionCardView, {
      decision,
      title: "Create an offer",
      toolName: TOOL,
      answer: { ...idle, ...answer }
    })
  );
}

const text = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");

describe("the decisions of a run's projection", () => {
  it("reads the decision of each call that waits, and no other part", () => {
    const decisions = readToolDecisions([
      { type: "text", text: "I will create the offer." },
      {
        type: "tool_call",
        toolCallId: "call_1",
        toolName: TOOL,
        state: "waiting_for_decision",
        decision: requested
      },
      { type: "tool_call", toolCallId: "call_2", toolName: TOOL, state: "input_available" }
    ]);
    expect([...decisions.keys()]).toEqual(["call_1"]);
    expect(decisions.get("call_1")).toEqual(waiting);
  });

  it("lists the input as the Inbox lists a held call: a row per field, objects one level open", () => {
    expect(toolDecisionInputRows(waiting.inputPreview)).toEqual([
      { key: "customer", value: "Müller GmbH", truncated: false },
      { key: "offer.amount", value: "1200", truncated: false },
      { key: "offer.currency", value: "EUR", truncated: false }
    ]);
    expect(toolDecisionInputRows("plain")).toEqual([
      { key: "input", value: "plain", truncated: false }
    ]);
    const long = toolDecisionInputRows({ text: "x".repeat(5_000) })[0];
    expect(long).toMatchObject({ truncated: true, length: 5_000 });
    expect(long?.value).toHaveLength(4_000);
  });
});

describe("the confirmation card", () => {
  it("shows the call, its input, the expiry, Allow, Deny and the way to a reason", () => {
    const markup = renderView(waiting);
    expect(markup).toContain('data-testid="tool-decision-card"');
    expect(markup).toContain('aria-label="Confirm Create an offer"');
    expect(text(markup)).toContain("Create an offer Runs only when you allow it.");
    expect(markup).toContain('data-input-key="customer"');
    expect(markup).toContain("Müller GmbH");
    expect(markup).toContain('data-input-key="offer.amount"');
    expect(text(markup)).toMatch(/Expires Oct 16, 2026/u);
    expect(text(markup)).toContain("Allow Deny Add a reason");
    // Denying is one click: no reason field until the person asks for one.
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain('data-testid="tool-decision-outcome"');
  });

  it("says in words which agent a save creates, with its definition only under details (ACCEPT-FIX-7 E5)", () => {
    const agentSave: ToolDecision = {
      ...waiting,
      operationId: "assets.put",
      inputPreview: {
        kind: "agent",
        name: "protokollant",
        config: {
          name: "protokollant",
          displayName: { de: "Protokollant", en: "Minute taker" },
          instructions: "Mach aus Stichpunkten ein kurzes Besprechungsprotokoll mit Datum.",
          skillNames: ["meeting-minutes"],
          toolNames: ["web_search", "read_skill"],
          welcomeMessage: { de: "Schick mir deine Stichpunkte", en: "Send me your notes" }
        }
      }
    };
    const markup = renderView(agentSave);
    const summary = /data-testid="tool-decision-agent".*?<\/dl>/su.exec(markup)?.[0] ?? "";
    expect(text(summary)).toContain("Name Minute taker");
    expect(text(summary)).toContain(
      "Instructions Mach aus Stichpunkten ein kurzes Besprechungsprotokoll mit Datum."
    );
    expect(text(summary)).toContain("Skills meeting-minutes");
    expect(text(summary)).toContain("Tools web_search read_skill");
    // The raw definition is folded under Technical details, which renders no content here.
    expect(markup).not.toContain('data-input-key="config.welcomeMessage"');
    expect(markup).not.toContain("Send me your notes");
    expect(markup).toContain('data-testid="tool-decision-details"');
    const german = text(renderView(agentSave, {}, "de"));
    expect(german).toContain("Name Protokollant");
    expect(german).toContain("Anweisungen Mach aus Stichpunkten");
    expect(german).toContain("Skills meeting-minutes");
    // Another call keeps its input as the card's body.
    expect(renderView(waiting)).not.toContain('data-testid="tool-decision-agent"');
    const noSkills = text(
      renderView({
        ...agentSave,
        inputPreview: { kind: "agent", name: "leer", config: { displayName: "Leer" } }
      })
    );
    expect(noSkills).toContain("Skills None");
    expect(noSkills).toContain("Tools None");
  });

  it("summarises the agent a chat agent's save creates, which waits under its tool name (ACCEPT-FIX-7 E5)", () => {
    // An agent's call waits under the name the agent called it by (`tool-operation.ts`), so an
    // agent created in chat reaches the card as `platform.assets.put`.
    const chatSave: ToolDecision = {
      ...waiting,
      operationId: "platform.assets.put",
      inputPreview: {
        kind: "agent",
        name: "protokollant",
        config: {
          displayName: "Protokollant",
          instructions: "Mach aus Stichpunkten ein Protokoll.",
          skillNames: [],
          toolNames: ["web_search"],
          modelBindingId: "primary"
        }
      }
    };
    const markup = renderView(chatSave, {}, "de");
    const summary = /data-testid="tool-decision-agent".*?<\/dl>/su.exec(markup)?.[0] ?? "";
    expect(text(summary)).toContain("Name Protokollant");
    expect(text(summary)).toContain("Anweisungen Mach aus Stichpunkten ein Protokoll.");
    expect(text(summary)).toContain("Skills Keine");
    expect(text(summary)).toContain("Tools web_search");
    expect(markup).not.toContain('data-input-key="config.modelBindingId"');
    // A save of another kind keeps its input as the card's body.
    expect(
      renderView({ ...chatSave, inputPreview: { kind: "skill", name: "notes", config: {} } })
    ).not.toContain('data-testid="tool-decision-agent"');
  });

  it("says in German what it asks", () => {
    const markup = text(renderView(waiting, {}, "de"));
    expect(markup).toContain("Läuft erst, wenn du es erlaubst.");
    expect(markup).toContain("Erlauben Ablehnen Grund angeben");
    expect(markup).toMatch(/Läuft ab am 16\.10\.2026/u);
  });

  it("asks what a Data Store row write changes and lists each row's key and values (RECORDS-AGENT)", () => {
    // The title is the one the run named the call's target with: the store's own.
    const rowWrite = (
      verb: string,
      inputPreview: unknown,
      targetTitle = "Holiday requests"
    ): ToolDecision => ({
      ...waiting,
      operationId: `data_store.ds_7f3a.${verb}`,
      ...(targetTitle ? { targetTitle } : {}),
      inputPreview
    });
    const summaryOf = (markup: string) =>
      /data-testid="operation-call-summary"[^>]*>([^<]*)</u.exec(markup)?.[1];
    const alex = { employee: "Alex", starts_on: "2026-11-02", ends_on: "2026-11-06" };

    const insert = renderView(rowWrite("insert", { table: "holiday_requests", rows: [alex] }));
    expect(summaryOf(insert)).toBe("Add 1 row to Holiday requests?");
    expect(insert).toMatch(/data-input-key="Table"[\s\S]*?holiday_requests/u);
    expect(insert).toMatch(
      /data-input-key="Row 1"[\s\S]*employee: Alex[\s\S]*ends_on: 2026-11-06/u
    );
    expect(insert).not.toContain("ds_7f3a");
    expect(
      summaryOf(
        renderView(
          rowWrite("insert", { table: "holiday_requests", rows: [alex, alex] }, "Urlaubsanträge"),
          {},
          "de"
        )
      )
    ).toBe("2 Datensätze zu Urlaubsanträge hinzufügen?");

    const update = rowWrite("update", {
      table: "holiday_requests",
      rows: [{ key: { id: 7 }, set: { ends_on: "2026-11-05" } }]
    });
    expect(summaryOf(renderView(update))).toBe("Change 1 row in Holiday requests?");
    const german = renderView(update, {}, "de");
    expect(summaryOf(german)).toBe("1 Datensatz in Holiday requests ändern?");
    expect(german).toMatch(/data-input-key="Tabelle"[\s\S]*?holiday_requests/u);
    expect(german).toMatch(/data-input-key="Datensatz 1, Schlüssel"[\s\S]*id: 7/u);
    expect(german).toMatch(/data-input-key="Datensatz 1, neue Werte"[\s\S]*ends_on: 2026-11-05/u);

    const removal = rowWrite("delete_rows", {
      table: "holiday_requests",
      keys: [{ id: 7 }, { id: 8 }]
    });
    expect(summaryOf(renderView(removal))).toBe("Delete 2 rows from Holiday requests?");
    // Without the store's title the question names the table, and still not the id.
    const untitled = rowWrite(
      "delete_rows",
      { table: "holiday_requests", keys: [{ id: 7 }, { id: 8 }] },
      ""
    );
    expect(summaryOf(renderView(untitled, {}, "de"))).toBe(
      "2 Datensätze aus holiday_requests löschen?"
    );

    // Not a row write, or not its shape: the input field by field, with no question.
    for (const decision of [
      waiting,
      rowWrite("query", { table: "holiday_requests", rows: [alex] }),
      rowWrite("delete_rows", { table: "holiday_requests", keys: [] })
    ]) {
      expect(renderView(decision)).not.toContain('data-testid="operation-call-summary"');
    }

    // The question stands once on the card, in either language.
    for (const decision of [
      rowWrite("insert", { table: "holiday_requests", rows: [alex] }),
      update,
      removal
    ]) {
      for (const locale of ["en", "de"] as const) {
        const markup = renderView(decision, {}, locale);
        expect(markup.match(/data-testid="operation-call-summary"/gu)).toHaveLength(1);
      }
    }
  });

  it("says what the person answered and offers nothing more until the run records it", () => {
    const denied = renderView(waiting, {
      decided: { decision: "decline", reason: "Not this customer." }
    });
    expect(denied).toContain('data-outcome="declined"');
    expect(text(denied)).toContain("Denied. Nothing ran. Reason: Not this customer.");
    expect(text(denied)).not.toContain("Allow Deny");
    expect(denied).not.toContain('data-testid="tool-decision-expires"');

    expect(text(renderView(waiting, { decided: { decision: "confirm" } }, "de"))).toContain(
      "Erlaubt. Der Aufruf läuft."
    );
    expect(text(renderView(waiting, { decided: { decision: "decline" } }))).not.toContain("Reason");
  });

  it("calls a refusal after the deadline already decided when the server says the call was decided", () => {
    // Confirmed in one tab before its deadline, declined from a stale tab after it: the call
    // may have run, so the card must not say that nothing ran.
    const alreadyConfirmed = new ApiError(409, "This call was already confirmed.", {
      error: {
        code: "CONFLICT",
        message: "This call was already confirmed. It cannot be declined any more.",
        details: { operationRunId: waiting.operationRunId }
      }
    });
    expect(toolDecisionFailure(alreadyConfirmed)).toBe("already_decided");
    // A conflict that names no reason at all is not taken for an expiry either.
    expect(toolDecisionFailure(new ApiError(409, "Conflict", "not an envelope"))).toBe(
      "already_decided"
    );
  });

  it("says an answer came too late when the server says the call's time ran out (EW-2c)", () => {
    const expired = new ApiError(409, "This call expired before it was decided.", {
      error: {
        code: "CONFLICT",
        message: "This call expired before it was decided. Nothing was executed.",
        details: { reason: DECISION_EXPIRED_REASON }
      }
    });
    expect(toolDecisionFailure(expired)).toBe("expired");
    expect(toolDecisionFailure(new ApiError(404, "Not found", {}))).toBe("not_yours");
    expect(toolDecisionFailure(new Error("offline"))).toBe("failed");
    expect(toolDecisionFailure(undefined)).toBeUndefined();

    expect(text(renderView(waiting, { failure: "expired" }))).toContain(
      "This call expired. Nothing ran."
    );
    expect(text(renderView(waiting, { failure: "expired" }, "de"))).toContain(
      "Dieser Aufruf ist abgelaufen. Nichts wurde ausgeführt."
    );
  });

  it("says why an answer was not taken", () => {
    expect(text(renderView(waiting, { failure: "already_decided" }))).toContain(
      "This call was already decided."
    );
    expect(text(renderView(waiting, { failure: "not_yours" }))).toContain(
      "Only the person who started this answer can decide."
    );
    expect(text(renderView(waiting, { failure: "failed" }, "de"))).toContain(
      "Deine Antwort wurde nicht gesendet. Versuch es noch einmal."
    );
  });
});

describe("Always allow on the confirmation card (OP-6)", () => {
  const offered: ToolDecision = { ...waiting, alwaysAllow: true };

  it("is offered only where the call offers it, and says it covers scheduled runs", () => {
    expect(text(renderView(waiting))).not.toContain("Always allow");
    const shown = text(renderView(offered));
    expect(shown).toContain("Allow Always allow Deny");
    expect(shown).toContain("Always allow also lets your scheduled runs do this without asking.");
    expect(text(renderView(offered, {}, "de"))).toContain("Erlauben Immer erlauben Ablehnen");
  });

  it("sends Always allow with the confirmation, and says that it no longer asks", () => {
    const decided = text(
      renderView(offered, { decided: { decision: "confirm", alwaysAllow: true } })
    );
    expect(decided).toContain("Allowed. From now on this runs without asking you.");
    expect(decided).not.toContain("Always allow Deny");
  });

  it("says when Always allow is no longer permitted, and decided nothing", () => {
    const refused = new ApiError(403, "Always allow is not available for this call", {
      error: {
        code: "FORBIDDEN",
        message: "Always allow is not available for this call",
        details: { reason: "always_allow_not_permitted" }
      }
    });
    expect(toolDecisionFailure(refused)).toBe("always_allow_refused");
    expect(text(renderView(offered, { failure: "always_allow_refused" }))).toContain(
      "Always allow is no longer available for this action. Allow or deny it this once."
    );
  });
});

describe("a tool call whose run waits for a decision", () => {
  function renderCall(
    parts: AgentRunProjection["parts"],
    props: { result?: unknown } = {}
  ): string {
    return inLocale(
      "en",
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(WorkspaceApiClientProvider, {
          apiBaseUrl: "http://127.0.0.1:1",
          children: createElement(
            ToolDisplayPanelProvider,
            null,
            createElement(ToolDecisionsProvider, {
              parts,
              children: createElement(ToolCallPart, {
                toolName: TOOL,
                toolCallId: "call_1",
                args: { customer: "Müller GmbH" },
                argsText: '{"customer":"Müller GmbH"}',
                result: props.result,
                type: "tool-call" as const,
                status:
                  props.result === undefined
                    ? { type: "running" as const }
                    : { type: "complete" as const },
                addResult: () => undefined,
                resume: () => undefined,
                respondToApproval: () => undefined
              })
            })
          )
        })
      )
    );
  }

  const part = {
    type: "tool_call" as const,
    toolCallId: "call_1",
    toolName: TOOL,
    state: "waiting_for_decision" as const,
    decision: requested
  };

  it("is the confirmation card while the call has not answered", () => {
    const markup = renderCall([part]);
    expect(markup).toContain('data-testid="tool-decision-card"');
    expect(markup).toContain('data-mode="confirm"');
  });

  it("is the plain tool call once the call answered, and without a decision", () => {
    expect(renderCall([part], { result: { offerId: "o_1" } })).not.toContain("tool-decision-card");
    expect(renderCall([])).not.toContain("tool-decision-card");
  });
});

// ACCEPT-FIX-11 C1: every confirmation reads in the person's language and words. A Knowledge
// Base's add_files names the base and the files as their person named them, never an id; a
// Workflow's publish says what goes live before Allow; a row write is titled by what it does
// and says a yes-or-no value as a word.
describe("a confirmation in the person's own words", () => {
  const API = "http://127.0.0.1:1";
  const title = (toolName: string, locale: "en" | "de") =>
    readToolDisplayProjection({ args: {}, result: undefined, toolName, locale }).title;

  it("titles a row write, an add_files and a publish by what they do, in either language", () => {
    expect(title("data_store.ds_7f3a.insert", "en")).toBe("Add rows");
    expect(title("data_store.ds_7f3a.update", "de")).toBe("Datensätze ändern");
    expect(title("data_store.ds_7f3a.delete_rows", "de")).toBe("Datensätze löschen");
    expect(title("knowledge.kb_notes.add_files", "en")).toBe("Add files to the Knowledge Base");
    expect(title("knowledge.kb_notes.add_files", "de")).toBe("Dateien zur Wissensbasis hinzufügen");
    expect(title("assets.publish", "de")).toBe("Veröffentlichen");
    // Any other operation of a store keeps the title its name gives.
    expect(title("data_store.ds_7f3a.select", "en")).toBe("Select");
  });

  it("says a yes-or-no value of a row as a word", () => {
    const decision: ToolDecision = {
      ...waiting,
      operationId: "data_store.ds_7f3a.insert",
      targetTitle: "Mandanten-Fristen",
      inputPreview: { table: "fristen", rows: [{ mandant: "Kai", erledigt: false, eilig: true }] }
    };
    const german = text(renderView(decision, {}, "de"));
    expect(german).toContain("erledigt: Nein");
    expect(german).toContain("eilig: Ja");
    const english = text(renderView(decision));
    expect(english).toContain("erledigt: No");
    expect(english).not.toMatch(/: (true|false)/u);
  });

  const user = (conversationId: string, files: { fileId: string; filename: string }[]) => ({
    id: "msg_user",
    conversationId,
    clientInstanceId: "client_test",
    role: "user" as const,
    text: "Lege die Unterlagen in die Wissensbasis.",
    createdAt: "2026-10-19T00:00:00.000Z",
    metadata: {
      agentRuntime: {
        version: 1,
        kind: "user_message",
        attachmentManifest: {
          version: 1,
          attachments: files.map((file) => ({
            ...file,
            kind: "file",
            attachmentId: `att_${file.fileId}`,
            byteSize: 10,
            status: "ready"
          }))
        }
      }
    }
  });

  function renderWaiting(input: {
    toolName: string;
    decision: Omit<ToolDecision, "toolCallId">;
    locale?: "en" | "de";
    seed?: (client: QueryClient) => void;
  }): string {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["operation-runs", API, "standalone", input.decision.operationRunId], {
      id: input.decision.operationRunId
    });
    input.seed?.(queryClient);
    return inLocale(
      input.locale ?? "en",
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(WorkspaceApiClientProvider, {
          apiBaseUrl: API,
          children: createElement(
            ToolDisplayPanelProvider,
            null,
            createElement(ToolDecisionsProvider, {
              parts: [
                {
                  type: "tool_call" as const,
                  toolCallId: "call_1",
                  toolName: input.toolName,
                  state: "waiting_for_decision" as const,
                  decision: input.decision
                }
              ],
              children: createElement(ToolCallPart, {
                toolName: input.toolName,
                toolCallId: "call_1",
                args: {},
                argsText: "{}",
                result: undefined,
                type: "tool-call" as const,
                status: { type: "running" as const },
                addResult: () => undefined,
                resume: () => undefined,
                respondToApproval: () => undefined
              })
            })
          )
        })
      )
    );
  }

  const addFiles = (fileIds: string[]) => ({
    operationRunId: "oprun_kb",
    operationId: "knowledge.kb_notes.add_files",
    mode: "confirm" as const,
    targetTitle: "Mandanten-Notizen",
    inputPreview: { files: fileIds.map((fileId) => ({ conversationId: "conv_1", fileId })) },
    expiresAt: "2026-10-19T18:30:00Z"
  });
  const threadOf = (files: { fileId: string; filename: string }[]) => (client: QueryClient) =>
    client.setQueryData(workspaceQueryKeys.thread(API, "standalone", "conv_1"), {
      conversation: { id: "conv_1" },
      messages: [user("conv_1", files)]
    });

  it("names the Knowledge Base and each file its person sent, never an id", () => {
    const sent = [
      { fileId: "file_fristen", filename: "Fristen 2026.pdf" },
      { fileId: "file_notiz", filename: "Notiz Kai.docx" }
    ];
    const german = renderWaiting({
      toolName: "knowledge.kb_notes.add_files",
      decision: addFiles(["file_fristen", "file_notiz"]),
      locale: "de",
      seed: threadOf(sent)
    });
    const words = text(german);
    expect(words).toContain("Dateien zur Wissensbasis hinzufügen");
    expect(words).toMatch(/Wissensbasis Mandanten-Notizen/u);
    expect(words).toContain("Fristen 2026.pdf");
    expect(words).toContain("Notiz Kai.docx");
    // The ids are a technical detail of the call: under Details at most, never in the lead.
    const lead = german.slice(0, german.indexOf('data-testid="tool-decision-details"'));
    expect(lead).not.toMatch(/file_fristen|file_notiz|conv_1/u);
    expect(lead).not.toContain('data-input-key="files"');

    // A file the conversation no longer names is counted with the rest.
    const english = renderWaiting({
      toolName: "knowledge.kb_notes.add_files",
      decision: addFiles(["file_fristen", "file_gone"]),
      seed: threadOf(sent)
    });
    const lead2 = english.slice(0, english.indexOf('data-testid="tool-decision-details"'));
    expect(text(lead2)).toContain("Files 2 files");
    expect(lead2).not.toMatch(/file_gone|Fristen 2026\.pdf/u);
  });

  const publish = {
    operationRunId: "oprun_pub",
    operationId: "assets.publish",
    mode: "confirm" as const,
    inputPreview: { kind: "workflow", name: "mandanten-fristen", revision: 2 },
    expiresAt: "2026-10-19T18:30:00Z"
  };
  const allowOf = (markup: string) =>
    markup.match(/<button[^>]*>(?:(?!<\/button>).)*(?:Allow|Erlauben)<\/button>/u)?.[0] ?? "";

  it("says what a Workflow's publish makes live before Allow, and holds Allow until then", () => {
    const summary =
      "Mandanten-Fristen läuft jeden Montag um 08:00 (Europe/Berlin) als Fristen-Konto und schreibt in Mandanten-Fristen, das Mara liest.";
    const ready = renderWaiting({
      toolName: "assets.publish",
      decision: publish,
      locale: "de",
      seed: (client) =>
        client.setQueryData(["publish-narrative", "de", API, "workflow", "mandanten-fristen", 2], {
          status: "present",
          narrative: { summary, warnings: [] }
        })
    });
    expect(text(ready)).toContain("Veröffentlichen");
    expect(ready).toContain(summary);
    expect(allowOf(ready)).not.toContain(`disabled=""`);
    // The raw inputs are details now.
    const lead = ready.slice(0, ready.indexOf('data-testid="tool-decision-details"'));
    expect(lead).not.toContain('data-input-key="kind"');

    const reading = renderWaiting({ toolName: "assets.publish", decision: publish });
    expect(reading).toContain('data-testid="publish-narrative-loading"');
    expect(allowOf(reading)).toContain(`disabled=""`);
  });
});

describe("the confirmation card of a mail (MAIL-2, check 138)", () => {
  const call: ToolDecision = {
    ...waiting,
    operationId: "mail.send",
    inputPreview: { to: ["anna@kanzlei.de"], subject: "Stand", body: "Alles **gut**." }
  };
  const mail: ToolDecision = {
    ...call,
    simulation: {
      simulated: true,
      preview: {
        from: { name: "Kanzlei Muster", address: "catalyst@mail.example.test" },
        to: [
          { kind: "person", label: "Anna Berg" },
          { kind: "address", label: "office@kanzlei.de" }
        ],
        cc: [],
        bcc: [{ kind: "address", label: "archiv@kanzlei.de" }],
        skipped: 1,
        subject: "Stand",
        html: "<p>Alles <strong>gut</strong>.</p>",
        text: "Alles gut.\n\n--\nAn agent of Example sent this e-mail on behalf of Kai."
      }
    }
  };

  it("shows the rendered mail with its sender and recipients, and no way to always allow it", () => {
    const markup = renderView(mail, {}, "en");
    const shown = text(markup);
    expect(markup).toContain('data-testid="mail-send-preview"');
    expect(shown).toContain("From Kanzlei Muster &lt;catalyst@mail.example.test&gt;");
    expect(shown).toContain("To Anna Berg office@kanzlei.de");
    expect(shown).toContain("Bcc archiv@kanzlei.de");
    expect(markup).not.toContain('data-field="mail-cc"');
    expect(shown).toContain("Subject Stand");
    expect(shown).toContain("An agent of Example sent this e-mail on behalf of Kai.");
    expect(markup).toContain('data-field="mail-skipped"');
    // The mail is what the card asks about: its raw input is under the details alone.
    expect(markup).not.toContain('data-input-key="subject"');
    expect(shown).toContain("Allow Deny");
    expect(shown).not.toMatch(/always/iu);
  });

  it("says the mail in German", () => {
    const shown = text(renderView(mail, {}, "de"));
    expect(shown).toContain("Von Kanzlei Muster &lt;catalyst@mail.example.test&gt;");
    expect(shown).toContain("An Anna Berg office@kanzlei.de");
    expect(shown).toContain("Betreff Stand");
  });

  it("falls back to the input where a mail call carries no simulation", () => {
    const markup = renderView(call);
    expect(markup).not.toContain('data-testid="mail-send-preview"');
    expect(markup).toContain('data-input-key="subject"');
  });
});
