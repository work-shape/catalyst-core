import { describe, expect, it } from "vitest";
import { type ApprovalCheckConfig, type ApprovalRequestHandler } from "@vivd-catalyst/core";
import {
  clientInstanceConfigSchema,
  parseClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import { assertClientAssemblyValid } from "../packages/client-assembly/src/assembly-validation";
import { createTestInstance, getTestExecution } from "./support/test-instance";

const rule: ApprovalCheckConfig = {
  id: "no_personal_data",
  appliesTo: "skill_change",
  modelBindingId: "guardrailCheck",
  instruction: "Prüfe den neuen Text auf personenbezogene Daten.",
  onFail: "warn"
};
const baseConfig = {
  clientInstance: { id: "approval-config", displayName: "Approval config" },
  modelBindings: [{ id: "guardrailCheck", providerId: "local", agentSelectable: false }]
};
const handler: ApprovalRequestHandler = {
  kind: "skill_change",
  requiredPermission: "agent_skills.approve",
  validate: (payload) => payload,
  preview: async (payload) => payload,
  isStale: async () => false,
  apply: async () => ({})
};

describe("approval check configuration", () => {
  it("defaults empty and accepts operator instructions in any language", () => {
    expect(parseClientInstanceConfig(baseConfig).approvalChecks).toEqual([]);
    expect(
      parseClientInstanceConfig({ ...baseConfig, approvalChecks: [rule] }).approvalChecks
    ).toEqual([rule]);
  });

  it.each([
    [{ ...rule }, { ...rule }],
    [{ ...rule, id: " " }],
    [{ ...rule, instruction: " " }],
    [{ ...rule, modelBindingId: " " }],
    [{ ...rule, appliesTo: " " }],
    [{ ...rule, onFail: "ignore" }]
  ])("rejects malformed or duplicate checks: %j", (...approvalChecks) => {
    expect(() => parseClientInstanceConfig({ ...baseConfig, approvalChecks })).toThrow(
      "Client instance config is invalid"
    );
  });

  it("rejects an unknown binding at config validation and reports it as an assembly issue", () => {
    const raw = { ...baseConfig, approvalChecks: [{ ...rule, modelBindingId: "missing" }] };
    expect(() => parseClientInstanceConfig(raw)).toThrow(
      "Approval check 'no_personal_data' references missing model binding 'missing'"
    );
    const config = clientInstanceConfigSchema.parse(raw);
    expect(() =>
      assertClientAssemblyValid({
        config,
        tools: [],
        approvalRequestHandlers: new Map([[handler.kind, handler]])
      })
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        message: "Client instance assembly is invalid",
        details: {
          issues: [
            {
              message:
                "Approval check 'no_personal_data' references model binding 'missing' that is missing from release config"
            }
          ]
        }
      })
    );
  });

  it("rejects a kind without a registered handler and accepts a handler without checkContent", () => {
    const config = parseClientInstanceConfig({ ...baseConfig, approvalChecks: [rule] });
    expect(() => assertClientAssemblyValid({ config, tools: [] })).toThrow(
      expect.objectContaining({
        details: {
          issues: [
            {
              message:
                "Approval check 'no_personal_data' references approval request kind 'skill_change' with no registered handler"
            }
          ]
        }
      })
    );
    expect(() =>
      assertClientAssemblyValid({
        config,
        tools: [],
        approvalRequestHandlers: new Map([[handler.kind, handler]])
      })
    ).not.toThrow();
  });

  it("requires check-model pricing when a spend budget is configured", () => {
    expect(() =>
      parseClientInstanceConfig({
        ...baseConfig,
        modelProviders: [
          {
            id: "remote",
            type: "openai-compatible",
            model: "cheap-check",
            baseUrl: "https://provider.example.test/v1",
            apiKeyEnvName: "TEST_KEY"
          }
        ],
        modelBindings: [{ id: "guardrailCheck", providerId: "remote" }],
        conversationTitles: { enabled: false },
        approvalChecks: [rule],
        usage: {
          budget: { dailySpendLimit: 10 },
          costs: { customer: { id: "rates", version: "1", currency: "EUR", models: [] } }
        }
      })
    ).toThrow("Spend budget requires configured customer pricing for model remote/cheap-check");
  });

  it("validates against the effective assembly registry, including the platform-owned skill handler", async () => {
    const config = parseClientInstanceConfig({ ...baseConfig, approvalChecks: [rule] });
    await expect(createTestInstance({ execution: { config, tools: [], env: {} } })).rejects.toThrow(
      "Client instance assembly is invalid"
    );
    config.administration.agentConfiguration.agentSkillChanges.enabled = true;
    const assembly = await createTestInstance({
      execution: {
        config,
        tools: [],
        env: {}
      }
    }).then(getTestExecution);
    try {
      expect(assembly.approvalRequestHandlers.has("skill_change")).toBe(true);
    } finally {
      await assembly.close();
    }
  });
});
