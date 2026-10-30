import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  runObservationSchema,
  unknownRunObservationSchema
} from "@work-shape/catalyst-api-contract";
import {
  applyAgentRunObservation,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type AgentRunProjection,
  type AgentRuntimeEvent,
  type RunObservation
} from "@work-shape/catalyst-core";
import { RunState } from "@work-shape/catalyst-agent-runtime";
import { CHAT_INPUT_FLOOR_GUARDRAILS } from "@work-shape/catalyst-config-schema";
import {
  CHAT_INPUT_RULE_WORDS,
  ChatInputGuardProvider,
  ChatInputNotice,
  GuardrailAnswerView,
  ReplyHoldNotice,
  readChatInputRefusal,
  toProjectionUiMessageParts,
  type ChatInputGuard
} from "./support/chat-ui/chat-guardrails";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The observations of a reply held for its check (GR-5, in the contract from GR-4), and what the
// chat shows of the guardrails on a person's message: why it was refused, a way to send it
// anyway where they only warned, and what they could not check. Spec:
// events-workflows-and-guardrails.md, acceptance checks 59 and 62.

const runId = asAgentRunId("run_held");
const WITHHELD_TEXT = "Die Kontonummer des Kunden lautet";

function heldRun() {
  const stored: AgentRuntimeEvent[] = [];
  const state = new RunState(runId, { onEvent: (event) => void stored.push(event) });
  return { state, stored };
}

async function observed(state: RunState): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of state.observe()) events.push(event);
  return events;
}

const render = (node: ReactNode, locale: "en" | "de" = "de") =>
  renderToStaticMarkup(createElement(TranslationProvider, { children: null, locale }, node));
const text = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");

describe("a held reply", () => {
  // Fails without the change: the deltas of a withheld reply were stored and streamed.
  it("stores and streams none of its deltas where it is withheld", async () => {
    const { state, stored } = heldRun();
    state.emit({ type: "message_held", runId });
    state.emit({ type: "message_delta", runId, delta: WITHHELD_TEXT });
    state.emit({ type: "message_delta", runId, delta: " DE89 3704" });
    state.emit({ type: "message_withheld", runId, guardrailId: "no-iban", reason: "Bankdaten." });
    state.complete();
    await state.waitForEventWrites();
    const events = await observed(state);
    expect(events.map((event) => event.type)).toEqual([
      "message_held",
      "message_withheld",
      "run_completed"
    ]);
    expect(JSON.stringify(stored)).not.toContain("Kontonummer");
    expect(JSON.stringify(events)).not.toContain("Kontonummer");
    // The sequence goes on without a gap where the dropped deltas were.
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(state.beginCancellation()).toBeUndefined();
  });

  it("streams its deltas in order after it is released", async () => {
    const { state, stored } = heldRun();
    state.emit({ type: "message_delta", runId, delta: "Vorab. " });
    state.emit({ type: "message_held", runId });
    state.emit({ type: "message_delta", runId, delta: "Geprüft " });
    state.emit({ type: "message_delta", runId, delta: "und frei." });
    state.emit({ type: "message_released", runId });
    state.emit({ type: "message_delta", runId, delta: " Mehr." });
    state.complete();
    await state.waitForEventWrites();
    expect(
      stored.map((event) => (event.type === "message_delta" ? event.delta : event.type))
    ).toEqual([
      "Vorab. ",
      "message_held",
      "message_released",
      "Geprüft ",
      "und frei.",
      " Mehr.",
      "run_completed"
    ]);
  });

  it("is in the observation contract, which a client of this release reads as known", () => {
    for (const payload of [
      { type: "message_held", runId, sequence: 4, createdAt: "2026-10-30T10:00:00.000Z" },
      { type: "message_released", runId, sequence: 5, createdAt: "2026-10-30T10:00:01.000Z" },
      {
        type: "message_withheld",
        runId,
        sequence: 6,
        createdAt: "2026-10-30T10:00:02.000Z",
        guardrailId: "no-iban",
        reason: "Bankdaten."
      }
    ]) {
      const observation = {
        clientInstanceId: "instance",
        runId,
        conversationId: "conv_1",
        ownerUserId: "user_1",
        sequence: payload.sequence,
        type: payload.type,
        payload,
        createdAt: payload.createdAt
      };
      expect(runObservationSchema.safeParse(observation).success, payload.type).toBe(true);
      expect(unknownRunObservationSchema.safeParse(observation).success).toBe(false);
    }
  });

  it("shows a waiting state while held and the reason once withheld, never the text", () => {
    const base: AgentRunProjection = {
      runId,
      lastSequence: 0,
      status: "running",
      parts: [],
      text: "",
      reasoning: [],
      activeToolCalls: []
    };
    const observe = (projection: AgentRunProjection, payload: RunObservation["payload"]) =>
      applyAgentRunObservation(projection, {
        clientInstanceId: asClientInstanceId("instance"),
        runId,
        conversationId: asConversationId("conv_1"),
        sequence: payload.sequence,
        type: payload.type,
        payload,
        createdAt: payload.createdAt
      });
    const held = observe(base, {
      type: "message_held",
      runId,
      sequence: 1,
      createdAt: "2026-10-30T10:00:00.000Z"
    });
    expect(held.hold).toEqual({ state: "held" });
    const heldParts = toProjectionUiMessageParts(held);
    expect(heldParts).toContainEqual({ type: "data-reply-hold", data: { state: "held" } });
    expect(text(render(createElement(ReplyHoldNotice, { hold: { state: "held" } })))).toContain(
      "Die Antwort wird geprüft, bevor sie erscheint."
    );

    const withheld = observe(held, {
      type: "message_withheld",
      runId,
      sequence: 2,
      createdAt: "2026-10-30T10:00:01.000Z",
      guardrailId: "no-iban",
      reason: "Bankdaten gehören nicht in Antworten."
    });
    expect(withheld.hold).toEqual({
      state: "withheld",
      guardrailId: "no-iban",
      reason: "Bankdaten gehören nicht in Antworten."
    });
    expect(withheld.text).toBe("");
    const words = text(
      render(createElement(ReplyHoldNotice, { hold: withheld.hold ?? { state: "held" } }))
    );
    expect(words).toContain("Die Antwort wurde von der Leitplanke „no-iban“ zurückgehalten.");
    expect(words).toContain("Grund: Bankdaten gehören nicht in Antworten.");

    const released = observe(held, {
      type: "message_released",
      runId,
      sequence: 2,
      createdAt: "2026-10-30T10:00:01.000Z"
    });
    expect(released.hold).toBeUndefined();
  });
});

function guardWith(overrides: Partial<ChatInputGuard>): ChatInputGuard {
  return {
    conversationId: "conv_1",
    refusal: undefined,
    sent: undefined,
    acceptsWarnings: () => false,
    refused: () => false,
    delivered: () => undefined,
    acceptWarnings: () => undefined,
    dismiss: () => undefined,
    ...overrides
  };
}

function notice(guard: ChatInputGuard, locale: "en" | "de" = "de") {
  return render(
    createElement(
      ChatInputGuardProvider,
      { value: guard },
      createElement(ChatInputNotice, { onSendAnyway: () => undefined })
    ),
    locale
  );
}

describe("the guardrails on a message, in the composer", () => {
  it("read a refusal from the error the instance sent, and nothing else", () => {
    const details = { reason: "chat_input_warning", guardrails: [] };
    expect(
      readChatInputRefusal({ code: "CONFLICT", payload: { error: { details } } })
    ).toMatchObject({ reason: "chat_input_warning" });
    expect(
      readChatInputRefusal({ code: "CONFLICT", payload: { error: { details: {} } } })
    ).toBeUndefined();
    expect(readChatInputRefusal(new Error("offline"))).toBeUndefined();
  });

  // Fails without the change: a warned message had no way to be sent anyway.
  it("offer to send a message anyway where they warned, and say it was not sent", () => {
    const markup = notice(
      guardWith({
        refusal: {
          conversationId: "conv_1",
          text: "Passwort: x",
          details: { reason: "chat_input_warning", guardrails: [] }
        }
      })
    );
    expect(markup).toContain('data-outcome="warn"');
    expect(markup).toContain('data-testid="chat-input-send-anyway"');
    expect(text(markup)).toContain("Trotzdem senden");
    expect(text(markup)).toContain("Noch nicht gesendet.");
  });

  it("offer no way past a block, and say what they could not check", () => {
    const markup = notice(
      guardWith({
        refusal: {
          conversationId: "conv_1",
          text: "Token",
          details: {
            reason: "chat_input_blocked",
            guardrails: [],
            attachmentsNotChecked: [
              { attachmentId: "att_1", filename: "vertrag.pdf", cause: "not_extracted" }
            ]
          }
        }
      })
    );
    expect(markup).toContain('data-outcome="block"');
    expect(markup).not.toContain("chat-input-send-anyway");
    expect(text(markup)).toContain("vertrag.pdf: der Text wird erst nach dem Senden gelesen");
  });

  it("say after sending what they could not check, only in the conversation it was sent in", () => {
    const sent = {
      conversationId: "conv_1",
      view: {
        attachmentsNotChecked: [
          { attachmentId: "att_2", filename: "foto.png", cause: "image" as const }
        ]
      }
    };
    expect(text(notice(guardWith({ sent }), "en"))).toContain(
      "Sent. The guardrails could not check these parts of the message:"
    );
    expect(notice(guardWith({ sent, conversationId: "conv_other" }))).toBe("");
  });

  it("name every default rule in German, and in English as release config says it", () => {
    expect(Object.keys(CHAT_INPUT_RULE_WORDS).sort()).toEqual(
      Object.keys(CHAT_INPUT_FLOOR_GUARDRAILS).sort()
    );
    for (const [name, rule] of Object.entries(CHAT_INPUT_FLOOR_GUARDRAILS)) {
      const answerView = (locale: "en" | "de") =>
        text(
          render(
            createElement(GuardrailAnswerView, {
              answer: {
                name,
                title: rule.displayName,
                outcome: rule.outcome,
                reason: rule.check.reason,
                origin: "release"
              },
              rule: undefined,
              instanceAdmin: undefined,
              client: undefined
            }),
            locale
          )
        );
      expect(answerView("en")).toContain(`“${rule.displayName}”`);
      expect(answerView("en")).toContain(rule.check.reason);
      expect(answerView("de")).not.toContain(rule.displayName);
      expect(answerView("de")).not.toContain(rule.check.reason);
    }
  });

  it("name a default rule in the reader's language", () => {
    const markup = render(
      createElement(GuardrailAnswerView, {
        answer: {
          name: "chat-secrets",
          title: "Secrets in chat",
          outcome: "block",
          reason: "The message contains what looks like an API key.",
          origin: "release"
        },
        rule: undefined,
        instanceAdmin: undefined,
        client: undefined
      })
    );
    expect(text(markup)).toContain("Leitplanke „Geheimnisse im Chat“");
    expect(text(markup)).toContain("Entferne ihn vor dem Senden");
  });
});
