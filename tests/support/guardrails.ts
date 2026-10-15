import { vi } from "vitest";
import {
  StoreBackedAuditRecorder,
  type ClientInstanceId,
  type GuardrailEvent,
  type PlatformEventEmitter
} from "@work-shape/catalyst-core";
import { GuardrailRunner, createAuditingEventEmitter } from "@work-shape/catalyst-server";
import {
  parseClientInstanceConfig,
  type ClientInstanceConfig,
  type ReleaseGuardrailConfig
} from "@work-shape/catalyst-config-schema";
import type { ModelCompletion } from "@work-shape/catalyst-model-provider";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { clientInstanceId as accessInstanceId } from "./access-instance";
import { createTestConfig } from "./fixtures";
import {
  createScriptedInstanceModelGateway,
  type FakeModelProvider as ModelProvider
} from "./model-gateway";
import type { TestInstance } from "./test-instance";

// Guardrails of release config for the tests of their events: an IBAN rule, a judge that
// answers that the content breaks its rule, and the event emitter that runs them.

type TestStore = TestInstance["stores"];

export const IBAN = "DE89 3704 0044 0532 0130 00";
export const ibanPattern = "(?i)\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b";
export const judgeBinding = {
  id: "guardrailCheck",
  providerId: "local",
  model: "cheap-check",
  agentSelectable: false
};

export function noIban(overrides: Partial<ReleaseGuardrailConfig> = {}): ReleaseGuardrailConfig {
  return {
    displayName: "No IBAN in skills",
    on: "asset.before_write",
    filter: { kind: "skill" },
    check: { kind: "pattern", pattern: ibanPattern, reason: "Skills hold no bank account." },
    outcome: "block",
    ...overrides
  };
}

export function judge(
  on: GuardrailEvent,
  outcome: ReleaseGuardrailConfig["outcome"]
): ReleaseGuardrailConfig {
  return {
    on,
    check: { kind: "model_judge", modelBindingId: judgeBinding.id, instruction: "Datenschutz." },
    outcome
  };
}

export function configWith(guardrails: Record<string, unknown>): ClientInstanceConfig {
  return parseClientInstanceConfig({
    ...createTestConfig({ modelBindings: [judgeBinding] }),
    guardrails
  });
}

function completion(text: string): ModelCompletion {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}

/**
 * The guardrails of these release entries, with a judge that answers `violates`. `shipped`
 * runs the guardrails the release ships too, as an assembled instance does.
 */
export function runnerOf(
  stores: TestStore,
  clientInstanceId: ClientInstanceId,
  guardrails: Record<string, unknown>,
  options: { shipped?: true } = {}
) {
  const config = configWith(guardrails);
  const complete = vi
    .fn<ModelProvider["complete"]>()
    .mockResolvedValue(completion('{"violates":true,"reason":"Names a person."}'));
  const runner = new GuardrailRunner({
    clientInstanceId,
    config,
    hits: stores.guardrails,
    // The published guardrails written as assets run beside the floor, as on an instance.
    assets: stores.configAssets,
    ...(options.shipped ? { shipped: stores.guardrails } : {}),
    modelGateway: createScriptedInstanceModelGateway({
      config,
      modelProvider: { complete },
      usageGovernance: new ModelUsageGovernance({
        store: stores.usage,
        budget: {},
        safeguards: {}
      })
    })
  });
  return { runner, complete };
}

/** The events of an instance whose release config holds these guardrails. */
export function guardedEvents(
  stores: TestStore,
  guardrails: Record<string, unknown>,
  options: { shipped?: true } = {}
) {
  const { runner, complete } = runnerOf(stores, accessInstanceId, guardrails, options);
  const events: PlatformEventEmitter = createAuditingEventEmitter(
    new StoreBackedAuditRecorder({ clientInstanceId: accessInstanceId, store: stores.audit }),
    runner
  );
  return { events, complete };
}
