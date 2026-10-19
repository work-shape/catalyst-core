import { describe, expect, it } from "vitest";
import {
  guardrailDenial,
  toolResultFromOperationResult
} from "@work-shape/catalyst-tool-execution";
import {
  createPlatformId,
  type GuardrailAnswer,
  type LocaleCode,
  type OperationDenial
} from "@work-shape/catalyst-core";

function refusal(reason: OperationDenial, locale: LocaleCode, policyReason?: string): string {
  const result = toolResultFromOperationResult(
    {
      result: { status: "denied", runId: createPlatformId<"OperationRunId">("operation"), reason }
    },
    {
      toolName: "propose_skill_change",
      agentName: "helper",
      correlationId: "test",
      locale,
      adminName: "Mara",
      ...(policyReason ? { policyReason } : {})
    }
  );
  if (result.status === "success") throw new Error("Expected a refusal");
  return result.error.message;
}

describe("ACCEPT-FIX-10 refusal language", () => {
  it.each(["en", "de"] as const)("names who can help the person in %s", (locale) => {
    const result = toolResultFromOperationResult(
      {
        result: {
          status: "denied",
          runId: createPlatformId<"OperationRunId">("operation"),
          reason: { kind: "forbidden", action: "ref:vault", reason: "no_grant" }
        }
      },
      {
        toolName: "propose_skill_change",
        agentName: "helper",
        correlationId: "test",
        locale,
        adminName: "Mara"
      }
    );
    expect(result.status).toBe("failed");
    if (result.status === "success") throw new Error("Expected a refusal");
    expect(result.error.message).toContain("Mara");
    expect(result.error.message).toContain(
      locale === "de" ? "Du hast hier nicht das nötige Recht" : "You do not have the right"
    );
    expect(result.error.message).not.toMatch(/ref:vault|helper|propose_skill_change|Settings/u);
  });

  it.each([
    ["en", "You do not have the right to edit skills here. Nothing ran."],
    ["de", "Du hast hier nicht das Recht „Skills bearbeiten“. Es wurde nichts ausgeführt."]
  ] as const)(
    "names the missing right by its verb in %s, never by its action id",
    (locale, words) => {
      const message = refusal(
        { kind: "forbidden", action: "skill.write", reason: "no_grant" },
        locale
      );
      expect(message).toBe(
        `${words} ${locale === "de" ? "Frag eine Instanz-Admin, zum Beispiel Mara." : "Ask an instance administrator, for example Mara."}`
      );
      expect(message).not.toContain("skill.write");
    }
  );

  it.each([
    ["en", "The shared account “Nightly import” lacks the right to add rows to data stores."],
    [
      "de",
      "Dem technischen Konto „Nightly import“ fehlt das Recht „Datensätze zu Datenspeichern hinzufügen“."
    ]
  ] as const)("names the right a shared account lacks in %s", (locale, words) => {
    const message = refusal(
      {
        kind: "forbidden",
        action: "data_store.insert",
        reason: "no_grant",
        boundBy: { id: "sp_1", label: "Nightly import" }
      },
      locale
    );
    expect(message.startsWith(words)).toBe(true);
    expect(message).not.toContain("data_store.insert");
  });

  it.each([
    ["en", "Ask the person who built this agent or an instance administrator, for example Mara."],
    [
      "de",
      "Frag die Person, die diesen Agenten gebaut hat, oder eine Instanz-Admin, zum Beispiel Mara."
    ]
  ] as const)("sends a person to the agent's builder for a tool it lacks in %s", (locale, help) => {
    const message = refusal(
      { kind: "forbidden", action: "agent_tool:private.tool", reason: "no_grant" },
      locale
    );
    expect(message.endsWith(help)).toBe(true);
  });

  it("quotes a tool's own English reason as the rule's words in a German refusal", () => {
    const message = refusal(
      { kind: "policy", operation: "demo.denied" },
      "de",
      "This tool is switched off for the pilot."
    );
    expect(message).toBe(
      "Diese Aktion ist hier durch eine Regel gesperrt. Begründung im Wortlaut der Regel: „This tool is switched off for the pilot.“ Frag eine Instanz-Admin, zum Beispiel Mara."
    );
  });

  it.each(["en", "de"] as const)(
    "names the call still needed in an agent handoff in %s",
    (locale) => {
      const result = toolResultFromOperationResult(
        {
          result: {
            status: "denied",
            runId: createPlatformId<"OperationRunId">("operation"),
            reason: { kind: "policy", operation: "demo.change", reason: "confirmation_required" }
          }
        },
        { toolName: "demo.change", agentName: "helper", correlationId: "test", locale }
      );
      if (result.status === "success") throw new Error("Expected a refusal");
      expect(result.error.message).toContain("'demo.change'");
      expect(result.error.message).toContain(
        locale === "de" ? "noch aufrufen muss" : "still needs to call"
      );
      expect(result.error.details).toEqual({ operation: "demo.change" });
    }
  );

  it("uses the title and German words when a guardrail prevents saving", () => {
    const guardrail: GuardrailAnswer = {
      guardrailName: "no-iban",
      displayName: "Keine IBAN",
      outcome: "block",
      reason: "Bankdaten sind hier nicht erlaubt.",
      origin: "release"
    };
    const result = guardrailDenial(
      [
        {
          outcome: "block",
          guardrails: [guardrail],
          subject: {
            kind: "skill",
            name: "pruefbericht-buchhaltung",
            title: { en: "Accounting review", de: "Buchhaltung prüfen" }
          }
        }
      ],
      "asset.before_write",
      "de"
    );
    expect(result).toMatchObject({
      kind: "guardrail",
      message:
        "Die Leitplanke „Keine IBAN“ hat die Aktion „Buchhaltung prüfen“ verhindert: Bankdaten sind hier nicht erlaubt."
    });
  });
});

describe("configuration and policy refusals keep their meaning", () => {
  it("keeps a tool-authored recovery hint instead of claiming a missing person right", () => {
    const toolResult = {
      status: "failed" as const,
      error: {
        code: "not_allowed" as const,
        message:
          "This Knowledge Base is not assigned to this agent. Search the Knowledge Bases the tool lists.",
        details: { reason: "knowledge_base_not_assigned" }
      }
    };
    expect(
      toolResultFromOperationResult(
        {
          result: {
            status: "done",
            runId: createPlatformId<"OperationRunId">("operation"),
            output: {}
          },
          toolResult
        },
        {
          toolName: "knowledge.search",
          agentName: "helper",
          correlationId: "test",
          locale: "de",
          adminName: "Mara"
        }
      )
    ).toBe(toolResult);
  });
  it.each(["en", "de"] as const)(
    "distinguishes agent setup from a person's right in %s",
    (locale) => {
      const result = toolResultFromOperationResult(
        {
          result: {
            status: "denied",
            runId: createPlatformId<"OperationRunId">("operation"),
            reason: {
              kind: "forbidden",
              action: "agent_tool:private.tool",
              reason: "no_grant"
            }
          }
        },
        {
          toolName: "private.tool",
          agentName: "helper",
          correlationId: "test",
          locale,
          adminName: "Mara"
        }
      );
      if (result.status === "success") throw new Error("Expected a refusal");
      expect(result.error.message).toContain(
        locale === "de" ? "Dieser Agent ist hier nicht" : "This agent is not set up"
      );
      expect(result.error.message).toContain("Mara");
      expect(result.error.message).not.toContain("private.tool");
    }
  );
  it.each(["approval_unavailable", "approval_stale", "workflow_deleted"] as const)(
    "words %s without operation ids",
    (reason) => {
      const result = toolResultFromOperationResult(
        {
          result: {
            status: "denied",
            runId: createPlatformId<"OperationRunId">("operation"),
            reason: {
              kind: "policy",
              operation: "data_store.private.insert",
              reason
            }
          }
        },
        {
          toolName: "data_store.private.insert",
          agentName: "helper",
          correlationId: "test",
          locale: "de",
          adminName: "Mara"
        }
      );
      if (result.status === "success") throw new Error("Expected a refusal");
      expect(result.error.message).not.toContain("data_store.private.insert");
      const expected = reason === "workflow_deleted" ? "Workflow" : "Freigabe";
      expect(result.error.message).toContain(expected);
    }
  );
});
