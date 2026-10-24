import { seedReleaseGuardrails } from "@work-shape/catalyst-server";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import type { ModuleSnapshot, PlatformStores } from "@work-shape/catalyst-core";
import type { InstanceConnections } from "./connections";
import { seedInstanceShippedAgents } from "./shipped-agents";
import { seedInstanceShippedSkills } from "./shipped-skills";

/**
 * What the API process writes before it takes a request: the Connections and Guardrails
 * release config defines and the skills and agents the platform ships. A worker reads what is stored. A
 * seed that fails closes what the start had opened.
 */
export async function seedInstance(
  execution: Parameters<typeof seedInstanceShippedSkills>[0] &
    Parameters<typeof seedInstanceShippedAgents>[0] & {
      config: ClientInstanceConfig;
      store: PlatformStores;
      modules: ModuleSnapshot;
      connections?: InstanceConnections | undefined;
      close(): Promise<void>;
    }
): Promise<void> {
  try {
    await execution.connections?.seed();
    // With the module off its stored guardrails are kept as they are, and inert.
    if (execution.modules.isEnabled("guardrails")) await seedGuardrails(execution);
    await seedInstanceShippedSkills(execution);
    // After the skills: a shipped agent lists the skills a capability ships.
    await seedInstanceShippedAgents(execution);
  } catch (error) {
    await execution.close();
    throw error;
  }
}

async function seedGuardrails(input: {
  clientInstanceId: Parameters<typeof seedReleaseGuardrails>[0]["clientInstanceId"];
  config: ClientInstanceConfig;
  store: PlatformStores;
  logger: Parameters<typeof seedInstanceShippedSkills>[0]["logger"];
}): Promise<void> {
  const guardrails = await seedReleaseGuardrails({
    clientInstanceId: input.clientInstanceId,
    guardrails: input.config.guardrails,
    stores: input.store
  });
  if (guardrails.created.length + guardrails.updated.length + guardrails.removed.length > 0) {
    // Names only. No instruction of a guardrail is logged.
    input.logger.info({ guardrails }, "Release Guardrails reconciled");
  }
  if (guardrails.conflicts.length > 0) {
    // The floor runs from release config all the same; the asset keeps the name in Build.
    input.logger.warn(
      { conflicts: guardrails.conflicts },
      "Release Guardrails share a name with a guardrail written as an asset"
    );
  }
}
