import { describe, expect, it } from "vitest";
import {
  guardrailDenial,
  toolResultFromOperationResult
} from "@work-shape/catalyst-tool-execution";
import { createPlatformId, type GuardrailAnswer } from "@work-shape/catalyst-core";

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
  it.each([
    "approval_unavailable",
    "approval_stale",
    "workflow_deleted",
    "confirmation_required"
  ] as const)("words %s without operation ids", (reason) => {
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
    const expected =
      reason === "workflow_deleted"
        ? "Workflow"
        : reason === "confirmation_required"
          ? "Bestätigung"
          : "Freigabe";
    expect(result.error.message).toContain(expected);
  });
});
