import type { ClientInstanceCapabilityContribution } from "@work-shape/catalyst-capability-sdk";
import type { PlatformStores } from "@work-shape/catalyst-core";
import type { InstanceConnections } from "./connections";
import { seedInstanceShippedAgents } from "./shipped-agents";
import { seedInstanceShippedSkills } from "./shipped-skills";

/**
 * What the API process writes before it takes a request: the Connections release config
 * defines, what each capability seeds (the guardrails of release config among them), and the
 * skills and agents the platform ships. A worker reads what is stored. A seed that fails
 * closes what the start had opened.
 */
export async function seedInstance(
  execution: Parameters<typeof seedInstanceShippedSkills>[0] &
    Parameters<typeof seedInstanceShippedAgents>[0] & {
      store: PlatformStores;
      connections?: InstanceConnections | undefined;
      capabilityContributions: readonly ClientInstanceCapabilityContribution[];
      close(): Promise<void>;
    }
): Promise<void> {
  try {
    await execution.connections?.seed();
    // A capability whose module is off contributes no seed, and what it stored stays as it is.
    for (const contribution of execution.capabilityContributions) {
      await contribution.instanceSeed?.({ stores: execution.store });
    }
    await seedInstanceShippedSkills(execution);
    // After the skills: a shipped agent lists the skills a capability ships.
    await seedInstanceShippedAgents(execution);
  } catch (error) {
    await execution.close();
    throw error;
  }
}
