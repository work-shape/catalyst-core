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

function refusalResult(
  reason: OperationDenial,
  locale: LocaleCode,
  options: { toolName?: string; policyReason?: string; adminName?: string } = {}
) {
  const result = toolResultFromOperationResult(
    {
      result: { status: "denied", runId: createPlatformId<"OperationRunId">("operation"), reason }
    },
    {
      toolName: options.toolName ?? "propose_skill_change",
      agentName: "helper",
      correlationId: "test",
      locale,
      ...(options.adminName === "" ? {} : { adminName: options.adminName ?? "Mara" }),
      ...(options.policyReason ? { policyReason: options.policyReason } : {})
    }
  );
  if (result.status === "success") throw new Error("Expected a refusal");
  return result;
}

const refusal = (...args: Parameters<typeof refusalResult>) => refusalResult(...args).error.message;

describe("ACCEPT-FIX-10 refusal language", () => {
  it.each(["en", "de"] as const)("names who can help the person in %s", (locale) => {
    const message = refusal({ kind: "forbidden", action: "ref:vault", reason: "no_grant" }, locale);
    expect(message).toContain("Mara");
    expect(message).not.toMatch(/ref:vault|helper|propose_skill_change|Settings/u);
  });

  it("names a missing right or a shared account's missing right, never by its action id", () => {
    expect(
      refusal({ kind: "forbidden", action: "skill.write", reason: "no_grant" }, "en")
    ).not.toContain("skill.write");
    const shared = refusal(
      {
        kind: "forbidden",
        action: "data_store.insert",
        reason: "no_grant",
        boundBy: { id: "sp_1", label: "Nightly import" }
      },
      "en"
    );
    expect(shared).toContain("Nightly import");
    expect(shared).not.toContain("data_store.insert");
  });

  it("quotes a tool's own reason in a policy refusal", () => {
    expect(
      refusal({ kind: "policy", operation: "demo.denied" }, "de", {
        policyReason: "This tool is switched off for the pilot."
      })
    ).toContain("This tool is switched off for the pilot.");
  });

  it("names the call still needed in an agent handoff", () => {
    const result = refusalResult(
      { kind: "policy", operation: "demo.change", reason: "confirmation_required" },
      "en",
      { toolName: "demo.change", adminName: "" }
    );
    expect(result.error.message).toContain("'demo.change'");
    expect(result.error.details).toEqual({ operation: "demo.change" });
  });

  it("names the guardrail, the subject's localized title and the reason when saving is prevented", () => {
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
      message: expect.stringMatching(
        /Keine IBAN.*Buchhaltung prüfen.*Bankdaten sind hier nicht erlaubt\./u
      )
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

  it("distinguishes agent setup from a person's right", () => {
    const message = refusal(
      { kind: "forbidden", action: "agent_tool:private.tool", reason: "no_grant" },
      "en",
      { toolName: "private.tool" }
    );
    expect(message).toContain("This agent is not set up");
    expect(message).toContain("Mara");
    expect(message).not.toContain("private.tool");
  });

  it.each(["approval_unavailable", "workflow_deleted"] as const)(
    "words %s without operation ids",
    (reason) => {
      const message = refusal(
        { kind: "policy", operation: "data_store.private.insert", reason },
        "de",
        { toolName: "data_store.private.insert" }
      );
      expect(message).not.toContain("data_store.private.insert");
      expect(message).toContain(reason === "workflow_deleted" ? "Workflow" : "Freigabe");
    }
  );
});
