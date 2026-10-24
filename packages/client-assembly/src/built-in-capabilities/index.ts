import type { ClientInstanceCapability } from "@work-shape/catalyst-capability-sdk";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { GUARDRAILS_CAPABILITY_NAME, createGuardrailsCapability } from "./guardrails";

export {
  GUARDRAILS_CAPABILITY_NAME,
  createGuardrailsCapability,
  guardrailsModule
} from "./guardrails";

/**
 * The capabilities the platform ships built in, first, then the deployment's own. A deployment
 * that passes a capability of a built-in one's name replaces it. Asked again of its own answer,
 * it adds nothing.
 */
export function withBuiltInCapabilities(
  config: ClientInstanceConfig,
  capabilities: readonly ClientInstanceCapability[]
): ClientInstanceCapability[] {
  const passed = new Set(capabilities.map((capability) => capability.name));
  const builtIn = passed.has(GUARDRAILS_CAPABILITY_NAME)
    ? []
    : [createGuardrailsCapability({ guardrails: config.guardrails })];
  return [...builtIn, ...capabilities];
}
