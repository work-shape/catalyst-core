import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ApprovalRequestHandler } from "@work-shape/catalyst-core";
import {
  APPROVAL_CHECKS_WITH_GUARDRAILS_REFUSAL,
  clientInstanceConfigSchema,
  loadClientInstanceConfigFromFile,
  parseClientInstanceConfig,
  type ReleaseGuardrailConfig
} from "@work-shape/catalyst-config-schema";
import { assertClientAssemblyValid } from "../packages/client-assembly/src/assembly-validation";
import { createTestInstance, getTestExecution } from "./support/test-instance";

const name = "no_personal_data";
const guardrail: ReleaseGuardrailConfig = {
  on: "approval_request.before_create",
  filter: { kind: "skill_change" },
  check: {
    kind: "model_judge",
    modelBindingId: "guardrailCheck",
    instruction: "Prüfe den neuen Text auf personenbezogene Daten."
  },
  outcome: "warn"
};
/** The approval check of the release before, which loads as `guardrail` above. */
const legacyCheck = {
  id: name,
  appliesTo: "skill_change",
  modelBindingId: "guardrailCheck",
  instruction: "Prüfe den neuen Text auf personenbezogene Daten.",
  onFail: "warn"
};
const baseConfig = {
  clientInstance: { id: "guardrail-config", displayName: "Guardrail config" },
  infrastructure: { models: { local: { provider: "deterministic" } } },
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

describe("guardrails in release config", () => {
  it("defaults empty and accepts operator instructions in any language", () => {
    expect(parseClientInstanceConfig(baseConfig).guardrails).toEqual({});
    expect(
      parseClientInstanceConfig({ ...baseConfig, guardrails: { [name]: guardrail } }).guardrails
    ).toEqual({ [name]: guardrail });
  });

  it.each([
    ["a name that is no machine name", { "No Personal": guardrail }],
    ["an event no guardrail runs at", { [name]: { ...guardrail, on: "message.before_send" } }],
    ["an unknown outcome", { [name]: { ...guardrail, outcome: "ignore" } }],
    [
      "an unknown check",
      { [name]: { ...guardrail, check: { ...guardrail.check, kind: "regex" } } }
    ],
    [
      "an empty instruction",
      { [name]: { ...guardrail, check: { ...guardrail.check, instruction: " " } } }
    ],
    [
      "an instruction past its limit",
      { [name]: { ...guardrail, check: { ...guardrail.check, instruction: "x".repeat(8_001) } } }
    ],
    ["an unknown field", { [name]: { ...guardrail, severity: "high" } }]
  ])("refuses %s", (_case, guardrails) => {
    expect(() => parseClientInstanceConfig({ ...baseConfig, guardrails })).toThrow(
      "Client instance config is invalid"
    );
  });

  it("loads approvalChecks of the release before as the guardrails they became", () => {
    expect(
      parseClientInstanceConfig({ ...baseConfig, approvalChecks: [legacyCheck] }).guardrails
    ).toEqual({ [name]: guardrail });
    expect(parseClientInstanceConfig({ ...baseConfig, approvalChecks: [] }).guardrails).toEqual({});
  });

  it("refuses approvalChecks beside guardrails, also in a file", async () => {
    const both = { ...baseConfig, approvalChecks: [], guardrails: {} };
    expect(() => parseClientInstanceConfig(both)).toThrow(APPROVAL_CHECKS_WITH_GUARDRAILS_REFUSAL);
    const file = join(await mkdtemp(join(tmpdir(), "guardrail-config-")), "app.json");
    await writeFile(file, JSON.stringify(both));
    await expect(loadClientInstanceConfigFromFile(file)).rejects.toThrow(
      APPROVAL_CHECKS_WITH_GUARDRAILS_REFUSAL
    );
  });

  it.each([
    [
      "a duplicate id",
      [legacyCheck, legacyCheck],
      "Duplicate approval check id 'no_personal_data'"
    ],
    [
      "an id no guardrail can be named",
      [{ ...legacyCheck, id: "No Personal" }],
      "becomes the guardrail of that name"
    ],
    [
      "an empty instruction",
      [{ ...legacyCheck, instruction: " " }],
      "approvalChecks.0.instruction"
    ],
    ["an unknown onFail", [{ ...legacyCheck, onFail: "ignore" }], "approvalChecks.0.onFail"]
  ])("refuses a legacy check with %s", (_case, approvalChecks, message) => {
    expect(() => parseClientInstanceConfig({ ...baseConfig, approvalChecks })).toThrow(message);
  });

  it("refuses an unknown model binding", () => {
    const check = { ...guardrail.check, modelBindingId: "missing" };
    expect(() =>
      parseClientInstanceConfig({ ...baseConfig, guardrails: { [name]: { ...guardrail, check } } })
    ).toThrow("Guardrail 'no_personal_data' references missing model binding 'missing'");
  });

  it("refuses a filter on a kind without a registered handler, and needs no filter", () => {
    const config = clientInstanceConfigSchema.parse({
      ...baseConfig,
      guardrails: { [name]: guardrail }
    });
    expect(() => assertClientAssemblyValid({ config, tools: [] })).toThrow(
      expect.objectContaining({
        details: {
          issues: [
            {
              message:
                "Guardrail 'no_personal_data' filters on approval request kind 'skill_change' with no registered handler"
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
    const { filter: _filter, ...everyKind } = guardrail;
    expect(() =>
      assertClientAssemblyValid({
        config: { ...config, guardrails: { [name]: everyKind } },
        tools: []
      })
    ).not.toThrow();
  });

  it("requires judge-model pricing when a spend budget is configured", () => {
    expect(() =>
      parseClientInstanceConfig({
        ...baseConfig,
        infrastructure: {
          models: {
            remote: {
              provider: "openai-compatible",
              region: "global",
              model: "cheap-check",
              baseUrl: "https://provider.example.test/v1",
              credentialSecret: "TEST_KEY"
            }
          }
        },
        modelBindings: [{ id: "guardrailCheck", providerId: "remote" }],
        conversationTitles: { enabled: false },
        guardrails: { [name]: guardrail },
        usage: {
          budget: { dailySpendLimit: 10 },
          costs: { customer: { id: "rates", version: "1", currency: "EUR", models: [] } }
        }
      })
    ).toThrow("Spend budget requires configured customer pricing for model remote/cheap-check");
  });

  it("validates against the effective assembly registry, including the platform-owned skill handler", async () => {
    const config = parseClientInstanceConfig({ ...baseConfig, guardrails: { [name]: guardrail } });
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
