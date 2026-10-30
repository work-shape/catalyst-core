import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { RuleInForceView } from "@work-shape/catalyst-api-client";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import {
  GuardrailAnswerView,
  RulesInForceList,
  changersSentence,
  guardrailAnswerOfErrorDetails,
  parseOperationCallPreview,
  readGuardrailRefusal,
  toolUiState,
  type AskClient,
  type GuardrailAnswerRef
} from "./support/chat-ui/chat-guardrails";

// A guardrail's answer where the person acts, and the Rules in force page (GR-3): the name,
// the reason, the outcome, the scope and the version, who can change it or that the operator
// set it, and a way to ask, in the reader's language.

const client: AskClient = { guardrails: { ask: () => Promise.reject(new Error("not asked")) } };

const salesRule: RuleInForceView = {
  name: "no-iban",
  displayName: "Keine IBAN",
  reason: "Bankdaten gehören nicht in Skills.",
  on: ["asset.before_write"],
  filter: { kind: "skill" },
  checkKind: "pattern",
  outcome: "block",
  origin: "asset",
  scope: { kind: "workspace", workspaceId: "cws_sales", workspaceName: "Vertrieb" },
  revision: 3,
  changedBy: "Mara Beispiel",
  changedAt: "2026-10-20T09:30:00.000Z",
  changers: ["Mara Beispiel", "Jo Muster"],
  askable: true,
  hitsLast30Days: 4
};

const floorRule: RuleInForceView = {
  name: "floor-secrets",
  displayName: "Keine Geheimnisse",
  reason: "Schlüssel bleiben im Tresor.",
  on: ["operation.before_call"],
  outcome: "block",
  origin: "release",
  scope: { kind: "instance" },
  changers: [],
  askable: false,
  hitsLast30Days: 0
};

const answerOf = (rule: RuleInForceView): GuardrailAnswerRef => ({
  name: rule.name,
  title: rule.displayName,
  outcome: rule.outcome,
  reason: rule.reason,
  origin: rule.origin,
  ...(rule.revision === undefined ? {} : { revision: rule.revision }),
  ...(rule.scope.kind === "workspace"
    ? { scope: { kind: "workspace" as const, workspaceId: rule.scope.workspaceId } }
    : {})
});

const render = (node: ReactNode, locale: "en" | "de" = "de") =>
  renderToStaticMarkup(createElement(TranslationProvider, { children: null, locale }, node));

const text = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");

describe("a guardrail's answer", () => {
  it("names the guardrail, why, what it did, where, which version and who can change it", () => {
    const markup = render(
      createElement(GuardrailAnswerView, {
        answer: answerOf(salesRule),
        rule: salesRule,
        instanceAdmin: undefined,
        client
      })
    );
    const words = text(markup);
    expect(words).toContain("Leitplanke „Keine IBAN“");
    expect(words).toContain("Bankdaten gehören nicht in Skills.");
    expect(words).toContain("Blockiert · Arbeitsbereich Vertrieb · Version 3");
    expect(words).toContain("Ändern können sie: Mara Beispiel, Jo Muster.");
    expect(words).toContain("Version 3 veröffentlicht von Mara Beispiel");
    expect(markup).toContain('data-testid="guardrail-answer-ask"');
    expect(markup).toContain('href="/settings/you/rules"');
  });

  it("says the operator set a floor rule, names nobody and offers no question", () => {
    const words = render(
      createElement(GuardrailAnswerView, {
        answer: answerOf(floorRule),
        rule: floorRule,
        instanceAdmin: "Mara Beispiel",
        client: undefined
      }),
      "en"
    );
    expect(text(words)).toContain("Set by the operator. Nobody here can change it.");
    expect(words).not.toContain("Mara");
    expect(words).not.toContain('data-testid="guardrail-answer-ask"');
  });

  it("names an admin for all workspaces where the reader may see no one who can change it", () => {
    const hidden: RuleInForceView = {
      ...salesRule,
      changers: [],
      changedBy: undefined,
      changedByHidden: true
    };
    expect(changersSentence(hidden, hidden, "Root Admin")).toEqual({
      key: "guardrailAnswer.changersAdmin",
      values: { name: "Root Admin" }
    });
    expect(changersSentence(hidden, hidden, undefined).key).toBe("guardrailAnswer.changersUnnamed");
    const many = { ...salesRule, changers: ["A", "B", "C", "D", "E"] };
    expect(changersSentence(many, many, undefined)).toEqual({
      key: "guardrailAnswer.changersMore",
      values: { names: "A, B, C", count: 2 }
    });
    const words = text(
      render(
        createElement(GuardrailAnswerView, {
          answer: answerOf(hidden),
          rule: hidden,
          instanceAdmin: undefined,
          client: undefined
        })
      )
    );
    expect(words).toContain("Version 3 veröffentlicht 20.10.");
    expect(words).not.toContain("Mara");
  });

  it("says an approval was asked for, on a held call", () => {
    const words = text(
      render(
        createElement(GuardrailAnswerView, {
          answer: { ...answerOf(salesRule), outcome: "require_approval" },
          rule: undefined,
          instanceAdmin: undefined,
          client: undefined
        }),
        "en"
      )
    );
    expect(words).toContain("Needs approval");
    expect(words).toContain("An approval was asked for.");
  });
});

describe("where the answer is read from", () => {
  const answer = answerOf(salesRule);

  it("reads it from a refused tool call, which then counts as failed", () => {
    const output = { status: "failed", guardrail: answer, message: "Blocked." };
    expect(readGuardrailRefusal(output)).toEqual(answer);
    expect(toolUiState({ result: output, toolName: "save_skill" })).toBe("failed");
    expect(readGuardrailRefusal({ status: "failed", guardrail: { name: 1 } })).toBeUndefined();
  });

  it("reads it from the details of a refused App action", () => {
    expect(guardrailAnswerOfErrorDetails({ guardrailId: "no-iban", guardrail: answer })).toEqual(
      answer
    );
    expect(guardrailAnswerOfErrorDetails({ guardrailId: "no-iban" })).toBeUndefined();
  });

  it("reads the guardrails of a held call from its Inbox preview", () => {
    const preview = parseOperationCallPreview({
      runId: "run_1",
      operation: "demo.send",
      effect: "changing",
      actor: { kind: "user", id: "usr_1", label: "Kai" },
      origin: { kind: "agent" },
      inputs: [],
      guardrails: [answer, { name: "broken" }]
    });
    expect(preview?.guardrails).toEqual([answer]);
  });
});

describe("Rules in force", () => {
  it("lists the operator's rules, then all workspaces, then each workspace, with counts only", () => {
    const instanceRule: RuleInForceView = {
      ...salesRule,
      name: "warn-mail",
      displayName: "Mails nach außen",
      outcome: "warn",
      scope: { kind: "instance" },
      on: ["operation.before_call"],
      filter: { operation: "mail.send" },
      checkKind: undefined,
      hitsLast30Days: 0
    };
    const markup = render(
      createElement(RulesInForceList, {
        rules: { items: [floorRule, instanceRule, salesRule] },
        failed: false,
        client,
        onRetry: () => undefined
      })
    );
    const words = text(markup);
    const order = ["Vom Betreiber festgelegt", "Alle Arbeitsbereiche", "Arbeitsbereich Vertrieb"];
    const positions = order.map((title) => words.indexOf(title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(words).toContain("4-mal in den letzten 30 Tagen");
    expect(words).toContain("Nicht in den letzten 30 Tagen");
    expect(words).toContain("Läuft, bevor jemand die Operation mail.send aufruft");
    // The floor names no one and takes no question; a published rule does.
    expect(markup.match(/data-testid="rule-in-force-ask"/gu)?.length).toBe(2);
  });

  it("says when nothing applies, and when the list could not be read", () => {
    const empty = text(
      render(
        createElement(RulesInForceList, {
          rules: { items: [] },
          failed: false,
          client,
          onRetry: () => undefined
        }),
        "en"
      )
    );
    expect(empty).toContain("No guardrails apply to you.");
    const failed = text(
      render(
        createElement(RulesInForceList, {
          rules: undefined,
          failed: true,
          client,
          onRetry: () => undefined
        }),
        "en"
      )
    );
    expect(failed).toContain("The rules in force could not be loaded.");
  });
});
