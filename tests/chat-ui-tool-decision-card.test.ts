import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AgentRunProjection } from "@work-shape/catalyst-api-client";
import { ToolCallPart, ToolDecisionsProvider } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import {
  ToolDecisionCardView,
  type ToolDecisionAnswer
} from "@work-shape/catalyst-chat-ui/tool-decision-card";
import {
  readToolDecisions,
  toolDecisionInputRows,
  type ToolDecision
} from "@work-shape/catalyst-chat-ui/tool-decision-model";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

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

  it("says in German what it asks", () => {
    const markup = text(renderView(waiting, {}, "de"));
    expect(markup).toContain("Läuft erst, wenn du es erlaubst.");
    expect(markup).toContain("Erlauben Ablehnen Grund angeben");
    expect(markup).toMatch(/Läuft ab am 16\.10\.2026/u);
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
