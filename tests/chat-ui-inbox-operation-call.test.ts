import { createElement } from "react";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  inboxItemKinds,
  inboxItemSurface,
  InboxList,
  item,
  now,
  render,
  renderItem
} from "./chat-ui-inbox-harness";

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
    expect(markup).toMatch(
      /data-testid="operation-call-why"[^>]*>.*Braucht eine Entscheidung, bevor es läuft\./u
    );
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
    expect(english).toContain("Needs a decision before it runs.");
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

    expect(markup).toMatch(
      /data-testid="operation-call-headline"[^>]*>Elif Aydin wants to create the skill “Elternzeit: häufige Fragen” in the Namespace hr-\.</u
    );
    expect(markup).toContain(
      "If you approve, it is saved as Elif Aydin. If you decline, nothing changes."
    );
    expect(markup).toMatch(
      /data-testid="operation-call-why"[^>]*>.*Needs a decision because this instance holds new and changed skills for approval\./u
    );
    expect(markup).toMatch(/>New skill: Elternzeit: häufige Fragen<\/h3>/u);
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
    expect(german).toContain(
      "Elif Aydin möchte die Fähigkeit „Elternzeit: häufige Fragen“ im Namespace hr- anlegen."
    );
    expect(german).toContain(
      "Wenn du freigibst, wird das als Elif Aydin gespeichert. Wenn du ablehnst, ändert sich nichts."
    );
    expect(german).toContain(
      "Braucht eine Entscheidung, weil diese Instanz neue und geänderte Fähigkeiten zur Freigabe vorlegt."
    );
    // Outside a Namespace the sentence names none.
    const { namespace: _namespace, ...plain } = newSkill;
    expect(put(plain)).toContain(
      "Elif Aydin wants to create the skill “Elternzeit: häufige Fragen”.<"
    );
  });

  it("gives the reason only where the request says a rule of the instance held it", () => {
    const { heldBy: _heldBy, ...unknown } = putPreview;
    for (const preview of [unknown, { ...putPreview, heldBy: "guardrail" }]) {
      const markup = put(newSkill, "en", preview);
      expect(markup).toContain("Needs a decision before it runs.");
      expect(markup).not.toContain("holds new and changed skills");
    }
  });

  it("shows a change as before and after, with what else changes about the skill", () => {
    const markup = put(changedSkill);

    expect(markup).toContain(
      "Elif Aydin wants to change the skill “Urlaubsrichtlinie” in the Namespace hr-."
    );
    expect(markup).toMatch(/>Skill change: Urlaubsrichtlinie<\/h3>/u);
    expect(markup).toMatch(/Before<\/span>.*Krankmeldung ab dem dritten Tag\./u);
    expect(markup).toMatch(/New<\/span>.*Krankmeldung ab dem ersten Tag\./u);
    expect(markup).toMatch(/data-field="title".*Before: Urlaub<.*New: Urlaubsrichtlinie</u);
    expect(markup).toContain("old/table.md");
    expect(markup).not.toContain('data-testid="operation-call-no-before"');

    // A reader who may not read the stored skill is told that nothing is compared.
    const withheld = put({
      ...changedSkill,
      previous: undefined,
      removedResources: undefined,
      beforeWithheld: true,
      content: {
        ...changedSkill.content,
        changes: [{ type: "replace", target: "root", after: "Krankmeldung ab dem ersten Tag." }]
      }
    });
    expect(withheld).toMatch(
      /data-testid="operation-call-no-before"[^>]*>.*You may not read this skill as it is now/u
    );
    expect(withheld).not.toContain("Before</span>");
    // A save that leaves the text as it is says so.
    expect(put({ ...changedSkill, content: { ...changedSkill.content, changes: [] } })).toContain(
      "The text of the skill stays as it is."
    );
  });

  it("names the surface and the row by the skill, with who asked and the Namespace", () => {
    expect(surface({ ...putPreview, asset: newSkill }, "en")).toMatchObject({
      title: "New skill",
      subtitle: "Elternzeit: häufige Fragen"
    });
    expect(surface({ ...putPreview, asset: changedSkill }, "en")).toMatchObject({
      title: "Skill change",
      subtitle: "Urlaubsrichtlinie"
    });
    expect(surface({ ...putPreview, asset: newSkill }, "de").title).toBe("Neue Fähigkeit");
    // A row carries no content: the list is not sent any.
    const { content: _content, ...listed } = newSkill;
    const markup = row({ ...putPreview, asset: listed });
    expect(markup).toContain("New skill: Elternzeit: häufige Fragen");
    expect(markup).toContain("Elif Aydin · hr-");
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

    expect(markup).toContain(
      "Elif Aydin wants to change the agent “Abwesenheiten” in the Namespace hr-."
    );
    expect(markup).toContain("Needs a decision before it runs.");
    expect(markup).toMatch(/>Action to approve<\/h3>/u);
    expect(markup).toMatch(/data-field="operation".*assets\.put/u);
    expect(markup).toMatch(
      /data-input-key="config\.instructions".*data-line="1"[^>]*>Ask\.\n<[\s\S]*data-line="2"[^>]*>Then file\./u
    );
    expect(markup).not.toContain('data-testid="operation-call-skill"');
    expect(put(asset, "de", agentPreview)).toContain(
      "Elif Aydin möchte den Agenten „Abwesenheiten“ im Namespace hr- ändern."
    );
    expect(surface({ ...agentPreview, asset }, "en").title).toBe("Action to approve");
  });
});
