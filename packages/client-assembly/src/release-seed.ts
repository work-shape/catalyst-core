import { seedReleaseGuardrails } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ClientInstanceId, Logger, PlatformStores } from "@vivd-catalyst/core";
import type { InstanceConnections } from "./connections";

/**
 * Makes the stored assets that release config defines equal to it: its Connections, then its
 * Guardrails. Only the API process seeds, before it takes a request; a worker reads what is
 * stored. A seed that fails closes what the start had opened.
 */
export async function seedReleaseAssets(execution: {
  config: ClientInstanceConfig;
  clientInstanceId: ClientInstanceId;
  store: PlatformStores;
  logger: Logger;
  connections?: InstanceConnections | undefined;
  close(): Promise<void>;
}): Promise<void> {
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
  } catch (error) {
    await execution.close();
    throw error;
  }
}
