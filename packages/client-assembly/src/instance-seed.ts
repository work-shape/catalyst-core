import { seedReleaseGuardrails } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { PlatformStores } from "@vivd-catalyst/core";
import type { InstanceConnections } from "./connections";
import { seedInstanceShippedSkills } from "./shipped-skills";

/**
 * What the API process writes before it takes a request: the Connections and Guardrails
 * release config defines and the skills the platform ships. A worker reads what is stored. A
 * seed that fails closes what the start had opened.
 */
export async function seedInstance(
  execution: Parameters<typeof seedInstanceShippedSkills>[0] & {
    config: ClientInstanceConfig;
    store: PlatformStores;
    connections?: InstanceConnections | undefined;
    close(): Promise<void>;
  }
): Promise<void> {
  try {
    await execution.connections?.seed();
    const guardrails = await seedReleaseGuardrails({
      clientInstanceId: execution.clientInstanceId,
      guardrails: execution.config.guardrails,
      stores: execution.store
    });
    if (guardrails.created.length + guardrails.updated.length + guardrails.removed.length > 0) {
      // Names only. No instruction of a guardrail is logged.
      execution.logger.info({ guardrails }, "Release Guardrails reconciled");
    }
    await seedInstanceShippedSkills(execution);
  } catch (error) {
    await execution.close();
    throw error;
  }
}
