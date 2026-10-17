import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ToolCallPart, ToolSubjectsProvider } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Every sentence of a Connection's step in the work history (UXA-7b), in both languages, for
// operation names as Connections bring them: plural, one verb alone, a verb and "me", and names
// in capitals, in camel case and with a version. A sentence is never empty, never the raw key
// and never reads a bare verb as what was read ("Read search from Notion"). A failed step in
// German needs no agreement with the name's number. The count of a read never breaks.

type Effect = "reading" | "changing" | undefined;
type State = "running" | "completed" | "failed";

const OPERATIONS = [
  "top_customers",
  "open_orders",
  "search",
  "fetch",
  "get_me",
  "ZRFC_GET_OPEN_ITEMS",
  "getCustomerByID",
  "v1.orders.list"
];
const CONNECTIONS = ["Sample accounts", "Notion", "Kundenstammdaten der Vertriebsgesellschaften"];
const EFFECTS: Effect[] = ["reading", "changing", undefined];
const STATES: State[] = ["running", "completed", "failed"];
const VERBS = "search|fetch|get|list|load|query|find|read|me";

function toolName(operation: string) {
  return `connection.conn.${operation}`;
}

function render(input: {
  operation: string;
  connection: string;
  effect: Effect;
  state: State;
  locale: "en" | "de";
  result?: unknown;
}): string {
  const name = toolName(input.operation);
  const tools = input.effect === undefined ? [] : [{ toolName: name, effect: input.effect }];
  const agents =
    input.effect === undefined
      ? []
      : [{ connections: [{ name: "conn", title: input.connection, tools }] }];
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: input.locale },
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(
          ToolSubjectsProvider,
          { agents, children: null },
          createElement(ToolCallPart, {
            toolName: name,
            toolCallId: "call_1",
            args: {},
            argsText: "{}",
            result:
              input.state === "running"
                ? undefined
                : input.state === "failed"
                  ? { error: "It failed." }
                  : (input.result ?? { ok: true }),
            isError: input.state === "failed",
            type: "tool-call" as const,
            status:
              input.state === "running"
                ? { type: "running" as const }
                : { type: "complete" as const },
            addResult: () => undefined,
            resume: () => undefined,
            respondToApproval: () => undefined
          })
        )
      )
    )
  );
}

function sentenceOf(markup: string): string {
  const match =
    /data-testid="tool-call-sentence"[^>]*>((?:[^<]|<span[^>]*>[^<]*<\/span>)*)<\/span>/u.exec(
      markup
    );
  return (match?.[1] ?? "").replace(/<[^>]+>/gu, "").replace(/&#x27;/gu, "'");
}

function sentence(
  operation: string,
  connection: string,
  effect: Effect,
  state: State,
  locale: "en" | "de"
) {
  return sentenceOf(render({ operation, connection, effect, state, locale }));
}

describe("the words of a Connection's step for every name", () => {
  it("is never empty, never the raw key and never reads a bare verb", () => {
    for (const operation of OPERATIONS) {
      for (const connection of CONNECTIONS) {
        for (const effect of EFFECTS) {
          for (const state of STATES) {
            for (const locale of ["en", "de"] as const) {
              const text = sentence(operation, connection, effect, state, locale);
              const where = `${operation} / ${connection} / ${effect} / ${state} / ${locale}: "${text}"`;
              expect(text.trim(), where).not.toBe("");
              // A name that is not plain words never stands as it is.
              if (/[_.A-Z]/u.test(operation)) {
                expect(text, where).not.toContain(operation);
              }
              expect(text, where).not.toContain("connection.");
              expect(text, where).not.toMatch(/_/u);
              if (effect === "reading") {
                // What was read is never only a verb or "me".
                expect(text, where).not.toMatch(
                  new RegExp(`\\b(read|reading|could not read) (${VERBS}) from\\b`, "iu")
                );
                expect(text, where).not.toMatch(
                  new RegExp(`^(liest |konnte )?(${VERBS}) aus\\b`, "iu")
                );
              }
            }
          }
        }
      }
    }
  });

  it("names the Connection alone where the operation is only a verb or a verb and me", () => {
    expect(sentence("search", "Notion", "reading", "completed", "en")).toBe("Read Notion");
    expect(sentence("search", "Notion", "reading", "completed", "de")).toBe("Aus Notion gelesen");
    expect(sentence("fetch", "Notion", "reading", "running", "de")).toBe("Liest aus Notion");
    expect(sentence("get_me", "GitHub", "reading", "completed", "en")).toBe("Read GitHub");
    expect(sentence("get_me", "GitHub", "reading", "failed", "de")).toBe(
      "Konnte GitHub nicht lesen"
    );
  });

  it("turns awkward names into the thing that was read", () => {
    expect(sentence("v1.orders.list", "Shop", "reading", "completed", "en")).toBe(
      "Read orders from Shop"
    );
    expect(sentence("getCustomerByID", "SAP", "reading", "completed", "en")).toBe(
      "Read customer by ID from SAP"
    );
    expect(sentence("ZRFC_GET_OPEN_ITEMS", "SAP", "reading", "completed", "de")).toBe(
      "Zrfc get open items aus SAP gelesen"
    );
  });

  it("says a failure in German without agreeing with the name's number", () => {
    expect(sentence("open_orders", "Sample accounts", "reading", "failed", "de")).toBe(
      "Konnte open orders aus Sample accounts nicht lesen"
    );
    expect(sentence("create_offer", "Sample accounts", "changing", "failed", "de")).toBe(
      "Konnte Sample accounts nicht ändern: create offer"
    );
    expect(sentence("create_offer", "Sample accounts", undefined, "failed", "de")).toBe(
      "Konnte conn nicht verwenden: create offer"
    );
    expect(sentence("open_orders", "Sample accounts", "reading", "failed", "en")).toBe(
      "Could not read open orders from Sample accounts"
    );
  });

  it("never cuts the sentence, and keeps the count of a read whole at its end", () => {
    const failed = render({
      operation: "open_orders",
      connection: CONNECTIONS[2] ?? "",
      effect: "reading",
      state: "failed",
      locale: "de"
    });
    const read = render({
      operation: "open_orders",
      connection: CONNECTIONS[2] ?? "",
      effect: "reading",
      state: "completed",
      locale: "de",
      result: { rows: [{}, {}, {}, {}, {}] }
    });
    for (const markup of [failed, read]) {
      // A long name wraps; the end of the sentence ("nicht lesen", "gelesen") is never cut.
      const classes = /<span class="([^"]*)" data-testid="tool-call-sentence"/u.exec(markup)?.[1];
      expect(classes).toBeDefined();
      expect(classes).not.toMatch(/line-clamp|truncate/u);
    }
    expect(sentenceOf(failed)).toBe(
      "Konnte open orders aus Kundenstammdaten der Vertriebsgesellschaften nicht lesen"
    );
    expect(sentenceOf(read)).toBe(
      "Open orders aus Kundenstammdaten der Vertriebsgesellschaften gelesen · 5 Zeilen"
    );
    // The count follows the words after a space and holds together: no lone "·" on a line.
    const count = /(.)<span class="([^"]*)" data-testid="tool-call-count">([^<]*)<\/span>/u.exec(
      read
    );
    expect(count?.[1]).toBe(" ");
    expect(count?.[2]).toContain("whitespace-nowrap");
    expect(count?.[3]).toBe("· 5 Zeilen");
  });
});
