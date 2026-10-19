import { createElement, type ReactNode } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  idleActions,
  inboxItemKinds,
  inboxItemSurface,
  InboxItemView,
  InboxList,
  item,
  now,
  render,
  renderItem
} from "./chat-ui-inbox-harness";
import { ApprovalRevisionHostProvider } from "./support/chat-ui";

/** The Inbox's host as one person reads it. */
const host = (currentUserId: string) => ({
  currentUserId,
  personalWorkspaceAgentName: () => undefined,
  startRevision: () => undefined,
  agentDisplayName: () => undefined,
  openConversation: () => undefined
});

describe("inbox item of an operation call", () => {
  const callPreview = {
    runId: "opr_1",
    operation: "workspace.apply_patch",
    effect: "changing",
    actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
    origin: { kind: "agent", agentName: "payroll-agent", toolName: "workspace_apply_patch" },
    workspaceId: "cw_team",
    inputs: [
      { key: "path", value: "docs/plan.md" },
      { key: "patch", value: "+ Neue Zeile", truncated: true }
    ],
    expiresAt: "2026-10-12T08:00:00Z"
  };
  const call = (overrides: Partial<ApprovalRequestView> = {}, locale: "de" | "en" = "de") =>
    renderItem(
      {
        kind: "operation_call",
        summary: "workspace.apply_patch",
        preview: callPreview,
        canDecide: true,
        ...overrides
      },
      { locale }
    );

  // Fails before INBOX-CARD-1: the item was headed with the operation's name, said "Approving
  // runs this call once" and listed origin and expiry before anything a person could read.
  it("leads with who wants what, then names the operation and shows each input in a block", () => {
    const markup = call();

    expect(markup).toContain('data-testid="operation-call"');
    expect(markup).toMatch(
      /data-testid="operation-call-headline"[^>]*>Anna Beispiel möchte eine ändernde Aktion ausführen\.</u
    );
    expect(markup).toContain(
      "Wenn du freigibst, läuft sie einmal als Anna Beispiel. Wenn du ablehnst, läuft nichts."
    );
    // No reason is given where no rule can be named.
    expect(markup).not.toContain('data-testid="operation-call-why"');
    expect(markup).toMatch(/>Aktion zur Freigabe<\/h3>/u);
    expect(markup).not.toContain("Aufruf einer Operation");
    expect(markup).toMatch(/data-field="operation".*workspace\.apply_patch/u);
    expect(markup).toMatch(/data-input-key="path".*data-slot="code-block".*docs\/plan\.md/u);
    expect(markup).toMatch(
      /data-input-key="patch" data-truncated="true".*\+ Neue Zeile[\s\S]*Gekürzt\./u
    );
    expect(markup.match(/data-input-key=/gu)).toHaveLength(2);
    // Where the call came from and when it expires are folded away, closed.
    expect(markup).toMatch(/data-testid="operation-call-details-open"[^>]*>.*Technische Details/u);
    expect(markup).not.toContain('data-field="origin"');
    expect(markup).not.toContain('data-field="expiresAt"');
    expect(markup).not.toContain('data-testid="operation-call-full-input"');

    const english = call({}, "en");
    expect(english).toContain("Anna Beispiel wants to run a changing action.");
    expect(english).toContain(
      "If you approve, it runs once as Anna Beispiel. If you decline, nothing runs."
    );
    expect(english).not.toContain("Needs a decision");
    expect(english).toMatch(/>Action to approve<\/h3>/u);
    expect(english).not.toContain("Operation call");
    expect(english).toContain("Shortened. The call runs with the full value.");
    expect(call({ preview: { ...callPreview, effect: "reading" } }, "en")).toContain(
      "Anna Beispiel wants to run a reading action."
    );
  });

  // Fails before the fix: the preview ended at 50 fields and 2,000 characters without a word,
  // and the item had no way to read the rest.
  it("says in words what the rows leave out and opens the fold with the full input", () => {
    const long = "x".repeat(2000);
    const payload = { runId: "opr_1", input: { path: "docs/plan.md", patch: `${long}tail` } };
    const markup = call({
      payload,
      preview: {
        ...callPreview,
        inputs: [
          { key: "path", value: "docs/plan.md" },
          { key: "patch", value: long, truncated: true, length: 2004 }
        ],
        inputFieldCount: 61
      }
    });

    expect(markup).toContain(
      "Gekürzt: Hier stehen 2000 von 2004 Zeichen. Der Aufruf läuft mit dem ganzen Wert, den die technischen Details zeigen."
    );
    expect(markup).toMatch(
      /data-testid="operation-call-hidden-fields"[^>]*>Dieser Aufruf hat 61 Eingabefelder\. Hier stehen die ersten 2\. Lies alle in der vollständigen Eingabe unter den technischen Details, bevor du entscheidest\./u
    );
    // The fold is open, with where the call came from, when it expires and the whole input.
    expect(markup).toMatch(/data-field="origin".*Agent, über Agent payroll-agent/u);
    expect(markup).toMatch(/data-field="tool".*workspace_apply_patch/u);
    expect(markup).toContain('data-field="expiresAt"');
    expect(markup).toContain("Danach verfällt der Aufruf und läuft nicht.");
    expect(markup).toMatch(/data-testid="operation-call-full-input"[\s\S]*xxxtail/u);

    const english = call({ payload, preview: { ...callPreview, inputFieldCount: 61 } }, "en");
    expect(english).toContain(
      "This call has 61 input fields. The first 2 are listed here. Read all of them in the full input under the technical details before you decide."
    );
    // Nothing is left out: no sentence about it, and the fold stays closed.
    const whole = call({ payload });
    expect(whole).not.toContain('data-testid="operation-call-hidden-fields"');
    expect(whole).not.toContain('data-testid="operation-call-full-input"');
  });

  // Fails before the fix: a decided item read "Übernommen" whatever became of the call.
  it("says what became of the call once the request is decided", () => {
    const ended = (status: ApprovalRequestView["status"], applyResult: Record<string, unknown>) =>
      call({
        status,
        canDecide: false,
        applyResult,
        payload: { runId: "opr_1", inputRemoved: true },
        preview: { ...callPreview, inputs: [], inputFieldCount: 0, inputRemoved: true }
      });
    const outcomes = [
      [
        "approved",
        { execution: "queued" },
        "Freigegeben. Der Aufruf wird ausgeführt.",
        "Freigegeben, läuft"
      ],
      [
        "approved",
        { execution: "done" },
        "Freigegeben und ausgeführt.",
        "Freigegeben und ausgeführt"
      ],
      [
        "approved",
        { execution: "failed", error: { message: "Revision 2 erwartet." } },
        "Freigegeben, aber der Aufruf ist fehlgeschlagen. Er wird nicht erneut ausgeführt.",
        "Freigegeben, fehlgeschlagen"
      ],
      [
        "approved",
        { execution: "interrupted" },
        "Ob er etwas geändert hat, ist nicht bekannt.",
        "Freigegeben, unterbrochen"
      ],
      [
        "superseded",
        { execution: "refused", error: { message: "Kein Mitglied mehr." } },
        "Nicht ausgeführt. Als der Aufruf laufen sollte, war er nicht mehr erlaubt.",
        "Nicht ausgeführt"
      ],
      [
        "superseded",
        { execution: "expired" },
        "Abgelaufen, bevor entschieden wurde. Es wurde nichts ausgeführt.",
        "Abgelaufen"
      ]
    ] as const;
    for (const [status, applyResult, sentence, badge] of outcomes) {
      const markup = ended(status, applyResult);
      expect(markup).toContain(`data-outcome="${applyResult.execution}"`);
      expect(markup).toContain(sentence);
      expect(markup).toContain(badge);
      // Nothing is asked any more: no sentence about what a decision would do.
      expect(markup).not.toContain('data-testid="operation-call-headline"');
      expect(markup).not.toContain("Wenn du freigibst");
      expect(markup).toMatch(/data-field="actor".*Anna Beispiel/u);
      // The input is gone, and the item says so instead of "no input".
      expect(markup).toContain(
        "Die Eingabe wurde entfernt, als diese Anfrage endete. Der Lauf behält einen Hash davon."
      );
      expect(markup).not.toContain("Dieser Aufruf hat keine Eingabe.");
    }
    expect(ended("approved", outcomes[2][1])).toContain("Grund: Revision 2 erwartet.");
    expect(ended("superseded", outcomes[4][1])).toContain("Grund: Kein Mitglied mehr.");
  });

  it("offers approve and decline and no request for changes", () => {
    const markup = call();

    expect(markup).toMatch(/data-decision="reject"[^>]*>Ablehnen<\/button>/u);
    expect(markup).toMatch(/data-decision="approve"[^>]*>Freigeben<\/button>/u);
    expect(markup).not.toContain('data-decision="request_changes"');
    expect(markup.match(/data-decision=/gu)).toHaveLength(2);
    const english = call({}, "en");
    expect(english).toMatch(/data-decision="reject"[^>]*>Decline<\/button>/u);
    expect(english).toMatch(/data-decision="approve"[^>]*>Approve<\/button>/u);
  });

  const kindOf = (kind: string) => inboxItemKinds.find((entry) => entry.kind === kind);
  const surface = (preview: ApprovalRequestView["preview"], locale: "de" | "en") =>
    inboxItemSurface(
      "apr_1",
      item({ kind: "operation_call", preview }),
      kindOf,
      createTranslationContext(locale).t
    );
  const row = (preview: ApprovalRequestView["preview"], locale: "de" | "en" = "en") =>
    render(
      createElement(InboxList, {
        tab: "to_decide",
        state: {
          status: "ready",
          items: [
            item({
              kind: "operation_call",
              summary: "assets.put",
              origin: undefined,
              requestedBy: { id: "user-elif", displayLabel: "Elif Aydin" },
              preview
            })
          ]
        },
        now,
        onOpenItem: () => undefined
      }),
      locale
    );

  it("names the surface an action to approve, and the row by who called which operation", () => {
    expect(surface(callPreview, "de")).toMatchObject({
      title: "Aktion zur Freigabe",
      subtitle: "workspace.apply_patch für Anna Beispiel"
    });
    expect(surface(callPreview, "en")).toMatchObject({
      title: "Action to approve",
      subtitle: "workspace.apply_patch for Anna Beispiel"
    });
    expect(surface({ operation: "assets.put" }, "en").subtitle).toBeUndefined();
    const markup = row(callPreview);
    expect(markup).toContain("Action to approve");
    expect(markup).toContain("Elif Aydin · workspace.apply_patch");
    expect(markup).toContain("lucide-zap");
  });

  it("shows a sentence instead of half a call when the preview cannot be read", () => {
    for (const preview of [
      undefined,
      { operation: "assets.put" },
      { ...callPreview, origin: { kind: "carrier_pigeon" } },
      { ...callPreview, actor: { kind: "user" } },
      { ...callPreview, effect: "deleting" }
    ]) {
      const markup = call({ preview });
      expect(markup).toContain('data-testid="operation-call-unreadable"');
      expect(markup).toContain("Die Details dieses Aufrufs können nicht angezeigt werden.");
      expect(markup).not.toContain('data-testid="operation-call"');
    }
    // An input that cannot be read is left out; the call still shows.
    const partial = call({
      preview: {
        ...callPreview,
        inputs: [{ key: "path", value: "a.md" }, { key: "n", value: 3 }, 7]
      }
    });
    expect(partial.match(/data-input-key=/gu)).toHaveLength(1);
    expect(call({ preview: { ...callPreview, inputs: [] } })).toContain(
      "Dieser Aufruf hat keine Eingabe."
    );
  });

  // INBOX-CARD-1. A held save of a skill reads as that skill. Every test below fails without
  // the `asset` block: the item named `assets.put` and showed the definition as one line.
  const skillText =
    "# Elternzeit: häufige Fragen\n\n- Sieben Wochen vor Beginn anmelden.\n- Teilzeit bis 32 Wochenstunden.\n";
  const putPreview = {
    runId: "opr_2",
    operation: "assets.put",
    effect: "changing",
    actor: { kind: "user", id: "user-elif", label: "Elif Aydin" },
    origin: { kind: "user" },
    heldBy: "central_setting",
    inputs: [
      { key: "kind", value: "skill" },
      { key: "config.content", value: skillText }
    ],
    expiresAt: "2026-10-12T08:00:00Z"
  };
  const newSkill = {
    kind: "skill",
    name: "hr-parental-leave-faq",
    title: "Elternzeit: häufige Fragen",
    description: "Nutzen bei Fragen zur Elternzeit.",
    namespace: "hr-",
    isNew: true,
    content: {
      skillName: "hr-parental-leave-faq",
      skillTitle: "Elternzeit: häufige Fragen",
      isNewSkill: true,
      changes: [],
      newSkill: {
        name: "hr-parental-leave-faq",
        title: "Elternzeit: häufige Fragen",
        description: "Nutzen bei Fragen zur Elternzeit.",
        content: skillText
      }
    }
  };
  const changedSkill = {
    kind: "skill",
    name: "hr-leave-policy",
    title: "Urlaubsrichtlinie",
    description: "Nutzen bei Fragen zu Urlaub.",
    namespace: "hr-",
    isNew: false,
    previous: { title: "Urlaub" },
    removedResources: ["old/table.md"],
    content: {
      skillName: "hr-leave-policy",
      skillTitle: "Urlaubsrichtlinie",
      isNewSkill: false,
      changes: [
        {
          type: "replace",
          target: "root",
          before: "Krankmeldung ab dem dritten Tag.",
          after: "Krankmeldung ab dem ersten Tag."
        }
      ]
    }
  };
  const put = (
    asset: Record<string, unknown>,
    locale: "de" | "en" = "en",
    preview: Record<string, unknown> = putPreview
  ) => call({ summary: "assets.put", preview: { ...preview, asset } }, locale);

  it("says who wants to create which skill where, why it waits, and shows the skill's text", () => {
    const markup = put(newSkill);

    // ACCEPT-FIX-9 C13: no Namespace prefix in what a person reads; it is an id.
    expect(markup).toMatch(
      /data-testid="operation-call-headline"[^>]*>Elif Aydin wants to create the skill “Elternzeit: häufige Fragen”\.</u
    );
    expect(markup).not.toContain("hr-<");
    expect(markup).not.toContain("Namespace");
    expect(markup).toContain(
      "If you approve, the skill is saved. If you decline, nothing changes."
    );
    expect(markup).toMatch(
      /data-testid="operation-call-why"[^>]*>.*Needs a decision because this instance holds new and changed skills for approval\./u
    );
    expect(markup).toMatch(/>New skill by Elif Aydin: Elternzeit: häufige Fragen<\/h3>/u);
    // The skill as people read one: title, description and the text with its line breaks,
    // shown at once and not as an input row.
    const skill = markup.slice(markup.indexOf('data-testid="operation-call-skill"'));
    expect(skill).toContain("Nutzen bei Fragen zur Elternzeit.");
    expect(skill).toContain(
      "- Sieben Wochen vor Beginn anmelden.\n- Teilzeit bis 32 Wochenstunden."
    );
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain('data-testid="operation-call-inputs"');
    expect(markup).not.toContain("\\n");
    // The operation's name is a technical detail of this item, folded away.
    expect(markup).not.toContain('data-field="operation"');
    expect(markup).not.toContain("assets.put");

    const german = put(newSkill, "de");
    expect(german).toContain("Elif Aydin möchte den Skill „Elternzeit: häufige Fragen“ anlegen.");
    expect(german).toContain(
      "Wenn du freigibst, wird der Skill gespeichert. Wenn du ablehnst, ändert sich nichts."
    );
    expect(german).toContain(
      "Braucht eine Entscheidung, weil diese Instanz neue und geänderte Skills zur Freigabe vorlegt."
    );
  });

  it("gives the reason only where the request says a rule of the instance held it", () => {
    const { heldBy: _heldBy, ...unknown } = putPreview;
    for (const preview of [unknown, { ...putPreview, heldBy: "guardrail" }]) {
      const markup = put(newSkill, "en", preview);
      expect(markup).not.toContain('data-testid="operation-call-why"');
      expect(markup).not.toContain("Needs a decision");
    }
  });

  // Fails without the fix round: a call held by an operation's floor said `declared_default`
  // and the item gave no reason at all.
  it("says that the action or its Connection operation asks for the approval where the floor held the call, in both languages", () => {
    const held = { ...callPreview, operation: "app.orders.save", heldBy: "policy_floor" };

    const german = call({ preview: held });
    expect(german).toMatch(
      /data-testid="operation-call-why"[^>]*>[\s\S]*Braucht eine Entscheidung, weil diese Aktion oder die Operation der Verbindung, die sie aufruft, immer eine Freigabe verlangt\. Das lässt sich in dieser Instanz nicht abschalten\./u
    );
    expect(call({ preview: held }, "en")).toContain(
      "Needs a decision because this action, or the connection operation it calls, always asks for an approval. No setting on this instance can switch that off."
    );
    expect(call({ preview: { ...held, heldBy: "central_setting" } })).not.toContain(
      'data-testid="operation-call-why"'
    );
  });

  it("shows a change as before and after, with what else changes about the skill", () => {
    const markup = put(changedSkill);

    expect(markup).toContain("Elif Aydin wants to change the skill “Urlaubsrichtlinie”.<");
    expect(markup).toContain(
      "If you approve, the change is saved. If you decline, nothing changes."
    );
    expect(put(changedSkill, "de")).toContain(
      "Wenn du freigibst, wird die Änderung gespeichert. Wenn du ablehnst, ändert sich nichts."
    );
    expect(markup).toMatch(/>Skill change by Elif Aydin: Urlaubsrichtlinie<\/h3>/u);
    expect(markup).toMatch(/Before<\/span>.*Krankmeldung ab dem dritten Tag\./u);
    expect(markup).toMatch(/New<\/span>.*Krankmeldung ab dem ersten Tag\./u);
    expect(markup).toMatch(/data-field="title".*Before: Urlaub<.*New: Urlaubsrichtlinie</u);
    expect(markup).toContain("old/table.md");
    // A request that is not outdated is approved or declined.
    expect(markup).toContain('data-decision="approve"');
    expect(markup).not.toContain('data-testid="operation-call-no-before"');

    // A save that leaves the text as it is says so.
    expect(put({ ...changedSkill, content: { ...changedSkill.content, changes: [] } })).toContain(
      "The text of the skill stays as it is."
    );
  });

  // Hosted check 39180143605: for a reader who may not read the skill, the server sends only
  // its kind, name and title. The item dropped that preview, and so showed the call's raw input
  // with the proposed text.
  it("shows a reader who may not read the skill its title and why, and nothing the call writes", () => {
    const current = "Krankmeldung ab dem dritten Tag.";
    const proposed = "Krankmeldung ab dem ersten Tag.";
    const withheldSkill = {
      kind: "skill",
      name: "hr-leave-policy",
      title: "Urlaubsrichtlinie",
      beforeWithheld: true
    };
    const withheld = (locale: "de" | "en") =>
      call(
        {
          summary: "assets.put",
          preview: {
            ...putPreview,
            // More fields than listed would open the technical details by themselves.
            inputs: [
              { key: "kind", value: "skill" },
              { key: "config.content", value: proposed }
            ],
            inputFieldCount: 4,
            asset: withheldSkill
          },
          payload: { runId: "opr_2", input: { config: { content: proposed } } }
        },
        locale
      );

    const en = withheld("en");
    expect(en).toMatch(
      /data-testid="operation-call-headline"[^>]*>Elif Aydin wants to save the skill “Urlaubsrichtlinie”\.</u
    );
    expect(en).toMatch(/data-field="title"[\s\S]*Urlaubsrichtlinie/u);
    expect(en).toMatch(
      /data-testid="operation-call-no-before"[\s\S]*You may not read the skill, so neither its current content nor the proposed content is shown\./u
    );
    expect(withheld("de")).toMatch(
      /data-testid="operation-call-headline"[^>]*>Elif Aydin möchte den Skill „Urlaubsrichtlinie“ speichern\.</u
    );
    expect(withheld("de")).toContain(
      "Du darfst den Skill nicht lesen. Deshalb wird weder der jetzige noch der vorgeschlagene Inhalt gezeigt."
    );
    for (const markup of [en, withheld("de")]) {
      expect(markup).not.toContain(proposed);
      expect(markup).not.toContain(current);
      expect(markup).not.toContain("config.content");
      expect(markup).not.toContain('data-testid="operation-call-skill"');
      expect(markup).not.toContain('data-testid="operation-call-full-input"');
    }
    // Nothing claims a new skill or a change of a stored one from what the server left out.
    expect(en).not.toContain("wants to create");
    expect(en).not.toContain("wants to change");
    expect(en).not.toContain("If you approve, the change is saved.");
  });

  // The server holds back every kind of asset, not only skills: the notice names the kind.
  it("names an agent the reader may not read as an agent, with its title and nothing it writes", () => {
    const proposed = "Antworte immer auf Englisch.";
    const markup = (locale: "de" | "en") =>
      call(
        {
          summary: "assets.put",
          preview: {
            ...putPreview,
            inputs: [{ key: "config.instructions", value: proposed }],
            asset: {
              kind: "agent",
              name: "hr-assistant",
              title: "HR-Assistent",
              beforeWithheld: true
            }
          },
          payload: { runId: "opr_2", input: { config: { instructions: proposed } } }
        },
        locale
      );

    expect(markup("en")).toMatch(
      /data-testid="operation-call-headline"[^>]*>Elif Aydin wants to save the agent “HR-Assistent”\.</u
    );
    expect(markup("en")).toContain(
      "You may not read the agent, so neither its current content nor the proposed content is shown."
    );
    expect(markup("de")).toContain(
      "Du darfst den Agenten nicht lesen. Deshalb wird weder der jetzige noch der vorgeschlagene Inhalt gezeigt."
    );
    for (const locale of ["en", "de"] as const) {
      expect(markup(locale)).not.toContain(proposed);
      expect(markup(locale)).not.toContain("Skill");
    }
  });

  // A preview frozen for a requester who could not read the skill holds neither whether the
  // save creates nor its text. A later reader who may read it gets the title alone: the item
  // names the skill and makes no claim of a new one or a change.
  it("names the skill of a frozen preview that says neither whether it is new nor what it writes", () => {
    const markup = put({ kind: "skill", name: "hr-leave-policy", title: "Urlaubsrichtlinie" });

    expect(markup).toMatch(
      /data-testid="operation-call-headline"[^>]*>Elif Aydin wants to save the skill “Urlaubsrichtlinie”\.</u
    );
    expect(markup).toContain("If you approve, it is saved as Elif Aydin.");
    expect(markup).not.toContain("wants to create");
    expect(markup).not.toContain("wants to change");
    expect(markup).not.toContain('data-testid="operation-call-no-before"');
    // A yes or no that is neither is not read as one.
    expect(
      put({ kind: "skill", name: "hr-leave-policy", title: "Urlaubsrichtlinie", isNew: "yes" })
    ).not.toContain("Urlaubsrichtlinie");
  });

  // ACCEPT-FIX-9 E4: once decided, the item read "Action to approve · assets.put" and "the
  // input was removed". The preview keeps the skill, so requester and approver read the skill
  // title and what changed after the decision too.
  it("keeps the skill's title and what changed once the request is decided", () => {
    const decided = (locale: "de" | "en", canDecide: boolean) =>
      call(
        {
          summary: "assets.put",
          status: "approved",
          canDecide,
          applyResult: { execution: "done" },
          payload: { runId: "opr_1", inputRemoved: true },
          preview: {
            ...putPreview,
            inputs: [],
            inputFieldCount: 0,
            inputRemoved: true,
            asset: changedSkill
          }
        },
        locale
      );
    // The approver, who could decide it, and the requester, who could not.
    for (const markup of [decided("en", true), decided("en", false)]) {
      expect(markup).toMatch(/>Skill change by Elif Aydin: Urlaubsrichtlinie<\/h3>/u);
      expect(markup).toMatch(/Before<\/span>.*Krankmeldung ab dem dritten Tag\./u);
      expect(markup).toMatch(/New<\/span>.*Krankmeldung ab dem ersten Tag\./u);
      expect(markup).toMatch(/data-testid="operation-call-outcome" data-outcome="done"/u);
      expect(markup).not.toContain("Action to approve");
      expect(markup).not.toContain('data-testid="operation-call-input-removed"');
      expect(markup).not.toContain("assets.put");
    }
    // ACCEPT-2d C-9: the German heading said "Fähigkeit" where body and Studio say "Skill".
    expect(decided("de", false)).toMatch(
      />Skill-Änderung von Elif Aydin: Urlaubsrichtlinie<\/h3>/u
    );
    const { content: _content, ...listed } = changedSkill;
    const decidedRow = row({ ...putPreview, inputs: [], inputRemoved: true, asset: listed });
    expect(decidedRow).toContain("Skill change by Elif Aydin: Urlaubsrichtlinie");
    expect(decidedRow).not.toContain("assets.put");
  });

  // ACCEPT-FIX-9 E7: an outdated request offered Approve without a word, although approving
  // applies nothing. ACCEPT-2d C-2: it then still offered Approve, its comparison read as a
  // revert of the newer text, and the requester was told to ask themselves.
  it.each(["agent", "workflow", "connection", "knowledge_base", "data_store", "app", "guardrail"])(
    "offers only Decline on a stale held %s save (LOWS-D)",
    (kind) => {
      for (const locale of ["en", "de"] as const) {
        const markup = put({ ...changedSkill, kind, isStale: true }, locale);
        expect(markup).toContain('data-testid="operation-call-stale"');
        expect(markup).toContain('data-decision="reject"');
        expect(markup).not.toContain('data-decision="approve"');
      }
    }
  );

  it("offers only Decline on a request whose skill changed since, labels its comparison and speaks to the reader's role", () => {
    const stale = { ...changedSkill, isStale: true };
    const asRequester = (markup: ReactNode) =>
      createElement(ApprovalRevisionHostProvider, { value: host("user-elif") }, markup);

    expect(put(stale)).toMatch(
      /data-testid="operation-call-stale"[^>]*>[\s\S]*This request is out of date: “Urlaubsrichtlinie” was changed after Elif Aydin made it, so it can no longer be approved\. Decline it; Elif Aydin can submit a new change\./u
    );
    expect(put(stale, "de")).toContain(
      "Diese Anfrage ist veraltet: „Urlaubsrichtlinie“ wurde geändert, nachdem Elif Aydin sie gestellt hat. Deshalb kann sie nicht mehr freigegeben werden. Lehne sie ab; Elif Aydin kann eine neue Änderung einreichen."
    );
    expect(put(changedSkill)).not.toContain('data-testid="operation-call-stale"');
    // The warning alone says what approving does: no sentence that approving saves the change.
    expect(put(stale)).not.toContain("If you approve, the change is saved.");
    expect(put(changedSkill)).toContain("If you approve, the change is saved.");

    // Only Decline: approving would apply nothing.
    expect(put(stale)).toContain('data-decision="reject"');
    expect(put(stale)).not.toContain('data-decision="approve"');

    // The comparison is against the version the requester saw, and says so, in both languages.
    expect(put(stale)).toMatch(
      /Version Elif Aydin saw<\/span>.*Krankmeldung ab dem dritten Tag\./u
    );
    expect(put(stale)).toMatch(/Proposed by Elif Aydin<\/span>.*Krankmeldung ab dem ersten Tag\./u);
    expect(put(stale)).toMatch(
      /data-field="title".*Version Elif Aydin saw: Urlaub<.*Proposed by Elif Aydin: Urlaubsrichtlinie</u
    );
    expect(put(stale, "de")).toContain("Version, die Elif Aydin gesehen hat");
    expect(put(stale, "de")).toContain("Vorschlag von Elif Aydin");
    expect(put(stale)).not.toMatch(/>Before<\/span>/u);

    // The requester reads their own request: nobody tells them to ask themselves.
    const own = (locale: "de" | "en") =>
      render(
        asRequester(
          createElement(InboxItemView, {
            state: {
              status: "ready",
              request: item({
                kind: "operation_call",
                summary: "assets.put",
                preview: { ...putPreview, asset: stale }
              })
            },
            actions: idleActions
          })
        ),
        locale
      );
    expect(own("en")).toContain(
      "Your request is out of date: “Urlaubsrichtlinie” was changed after you made it, so it can no longer be approved. Submit a new change if it is still needed."
    );
    expect(own("de")).toContain(
      "Deine Anfrage ist veraltet: „Urlaubsrichtlinie“ wurde geändert, nachdem du sie gestellt hast. Deshalb kann sie nicht mehr freigegeben werden. Reiche eine neue Änderung ein, wenn sie noch nötig ist."
    );
    expect(own("en")).not.toContain("Ask Elif Aydin");
    expect(own("en")).not.toContain("Elif Aydin can submit");
  });

  // ACCEPT-FIX-9 E7: approving an outdated request ended "Not executed … no longer allowed"
  // with the instance's English sentence as the reason, also in German. ACCEPT-2d C-2: the
  // approver was then told "Submit a new change", which only the requester can.
  it("says in the reader's language and role that an outdated request was approved and nothing applied", () => {
    const refusedStale = {
      summary: "assets.put",
      status: "superseded" as const,
      canDecide: false,
      applyResult: {
        execution: "refused" as const,
        error: {
          code: "APPROVAL_STALE",
          message:
            "The asset changed after this request was made. Submit a new change; nothing was applied."
        }
      },
      payload: { runId: "opr_2", inputRemoved: true },
      preview: { ...putPreview, inputs: [], inputRemoved: true, asset: changedSkill }
    };
    const read = (locale: "de" | "en", reader?: string) => {
      const view = createElement(InboxItemView, {
        state: { status: "ready", request: item({ kind: "operation_call", ...refusedStale }) },
        actions: idleActions
      });
      return render(
        reader === undefined
          ? view
          : createElement(ApprovalRevisionHostProvider, { value: host(reader) }, view),
        locale
      );
    };

    // The approver, who decided it.
    const german = read("de", "user-jonas");
    expect(german).toMatch(
      /data-testid="operation-call-outcome" data-outcome="refused"[^>]*>[\s\S]*Nicht übernommen: „Urlaubsrichtlinie“ wurde nach dieser Anfrage geändert, deshalb hat sich nichts geändert\. Elif Aydin kann eine neue Änderung einreichen\./u
    );
    expect(german).not.toContain("Reiche eine neue Änderung ein");
    expect(german).not.toContain("The asset changed");
    expect(german).not.toContain("nicht mehr erlaubt");
    expect(read("en", "user-jonas")).toContain(
      "Not applied: “Urlaubsrichtlinie” was changed after this request was made, so nothing changed. Elif Aydin can submit a new change."
    );
    expect(read("en")).toContain("Elif Aydin can submit a new change.");
    // The requester, who can submit a new one.
    expect(read("de", "user-elif")).toContain(
      "Nicht übernommen: „Urlaubsrichtlinie“ wurde nach dieser Anfrage geändert, deshalb hat sich nichts geändert. Reiche eine neue Änderung ein, wenn sie noch nötig ist."
    );
    expect(read("en", "user-elif")).toContain(
      "Not applied: “Urlaubsrichtlinie” was changed after this request was made, so nothing changed. Submit a new change if it is still needed."
    );
  });

  it("names the surface and the row by the skill, with who asked and no Namespace prefix", () => {
    expect(surface({ ...putPreview, asset: newSkill }, "en")).toMatchObject({
      title: "New skill",
      subtitle: "Elternzeit: häufige Fragen"
    });
    expect(surface({ ...putPreview, asset: changedSkill }, "en")).toMatchObject({
      title: "Skill change",
      subtitle: "Urlaubsrichtlinie"
    });
    expect(surface({ ...putPreview, asset: newSkill }, "de").title).toBe("Neuer Skill");
    // A row carries no content: the list is not sent any.
    const { content: _content, ...listed } = newSkill;
    const markup = row({ ...putPreview, asset: listed });
    expect(markup).toContain("New skill by Elif Aydin: Elternzeit: häufige Fragen");
    expect(markup).toContain("Elif Aydin");
    expect(markup).not.toContain("hr-");
    expect(markup).toContain("lucide-book-open");
    expect(markup).not.toContain("lucide-zap");
    expect(markup).not.toContain("assets.put");
  });

  it("names an asset of another kind in the sentence and shows its input like any other call", () => {
    const agentPreview = {
      ...putPreview,
      inputs: [
        { key: "kind", value: "agent" },
        { key: "config.instructions", value: "Ask.\nThen file." }
      ]
    };
    const asset = {
      kind: "agent",
      name: "hr-absence-desk",
      title: "Abwesenheiten",
      namespace: "hr-",
      isNew: false
    };
    const markup = put(asset, "en", agentPreview);

    expect(markup).toContain("Elif Aydin wants to change the agent “Abwesenheiten”.<");
    expect(markup).toContain(
      "If you approve, it is saved as Elif Aydin. If you decline, nothing changes."
    );
    expect(markup).not.toContain('data-testid="operation-call-why"');
    expect(markup).toMatch(/>Action to approve<\/h3>/u);
    expect(markup).toMatch(/data-field="operation".*assets\.put/u);
    expect(markup).toMatch(
      /data-input-key="config\.instructions".*data-line="1"[^>]*>Ask\.\n<[\s\S]*data-line="2"[^>]*>Then file\./u
    );
    expect(markup).not.toContain('data-testid="operation-call-skill"');
    expect(put(asset, "de", agentPreview)).toContain(
      "Elif Aydin möchte den Agenten „Abwesenheiten“ ändern."
    );
    expect(surface({ ...agentPreview, asset }, "en").title).toBe("Action to approve");
  });
});
