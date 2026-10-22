import { describe, expect, it } from "vitest";
import { GUARDRAIL_EVENTS } from "@work-shape/catalyst-core";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  guardrailRunSentence,
  type GuardrailRunFacts
} from "@work-shape/catalyst-chat-ui/build-area";

// When a guardrail runs and what it does, in one line (Felix, 2026-10-14): built from its
// event, filter, check, outcome and scope, in English and German, with no event id in it.

const workspaces: Record<string, string> = { cws_kai: "Kai Spezis" };

function sentence(facts: GuardrailRunFacts, locale: "en" | "de" = "en"): string {
  const { t } = createTranslationContext(locale);
  return guardrailRunSentence(facts, {
    t,
    workspaceName: (id) => workspaces[id],
    requestKind: (kind) => (kind === "skill_change" ? "Skill change" : undefined)
  });
}

const agentSavesSkill: GuardrailRunFacts = {
  event: "asset.before_write",
  outcome: "block",
  checkKind: "pattern",
  kind: "skill",
  callOrigin: "agent",
  scope: { kind: "workspace", workspaceId: "cws_kai" },
  setByOperator: false
};

describe("the sentence of when a guardrail runs", () => {
  it("names the actor, the action, the workspace, the check and the outcome", () => {
    expect(sentence(agentSavesSkill)).toBe(
      "Runs before an agent saves a skill, in workspace Kai Spezis. Checks the content for a text pattern. Blocks if the check fails."
    );
    expect(sentence(agentSavesSkill, "de")).toBe(
      "Läuft, bevor ein Agent einen Skill speichert, im Workspace Kai Spezis. Prüft den Inhalt auf ein Textmuster. Blockiert, wenn die Prüfung anschlägt."
    );
  });

  it("says a guardrail without a check asks on every event it applies to", () => {
    const publish: GuardrailRunFacts = {
      event: "app.before_publish",
      outcome: "require_approval",
      scope: { kind: "instance" },
      setByOperator: false
    };
    expect(sentence(publish)).toBe(
      "Runs before anyone publishes an App, instance-wide. Asks an admin to approve."
    );
    expect(sentence(publish, "de")).toBe(
      "Läuft, bevor jemand eine App veröffentlicht, instanzweit. Bittet einen Admin um Freigabe."
    );
  });

  it("says the release floor is set by the operator, and a model check reads the content", () => {
    const floor: GuardrailRunFacts = {
      event: "approval_request.before_create",
      outcome: "warn",
      checkKind: "model_judge",
      kind: "skill_change",
      scope: { kind: "instance" },
      setByOperator: true
    };
    expect(sentence(floor)).toBe(
      "Runs before anyone asks for an approval of the kind Skill change, instance-wide, part of the instance's setup. Checks the content for breaches of its rule, with a model. Warns if the check fails."
    );
    expect(sentence(floor, "de")).toBe(
      "Läuft, bevor jemand eine Freigabe der Art Skill change anfragt, instanzweit, aus der Einrichtung der Instanz. Prüft den Inhalt mit einem Modell auf Verstöße gegen ihre Regel. Warnt, wenn die Prüfung anschlägt."
    );
  });

  it("names an agent, an operation or a prefix, and a workspace it does not know by name", () => {
    expect(
      sentence({
        event: "operation.before_call",
        outcome: "require_approval",
        checkKind: "pattern",
        operation: "data_store.*",
        agent: "assistant",
        scope: { kind: "workspace", workspaceId: "cws_other" },
        setByOperator: false
      })
    ).toBe(
      "Runs before the agent assistant calls an operation whose name starts with data_store., in one workspace. Checks the content for a text pattern. Asks an admin to approve if the check fails."
    );
    expect(
      sentence({
        event: "operation.before_call",
        outcome: "allow",
        checkKind: "pattern",
        operation: "connection.books.read",
        callOrigin: "cli",
        workspace: "cws_kai",
        scope: { kind: "instance" },
        setByOperator: false
      })
    ).toBe(
      "Runs before someone with the CLI calls the operation connection.books.read, in workspace Kai Spezis. Checks the content for a text pattern. Lets the action go on."
    );
  });

  it("names no event id, for every event and for one this build does not know", () => {
    for (const event of [...GUARDRAIL_EVENTS, "message.before_send"]) {
      for (const locale of ["en", "de"] as const) {
        const said = sentence({ ...agentSavesSkill, event, kind: undefined }, locale);
        expect(said, `${event} ${locale}`).not.toContain(event);
        expect(said).not.toMatch(/guardrails\./u);
      }
    }
    expect(sentence({ ...agentSavesSkill, event: "message.before_send" })).toContain(
      "before an action this version cannot name"
    );
  });
});
