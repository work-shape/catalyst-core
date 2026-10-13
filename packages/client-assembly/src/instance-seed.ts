import type { InstanceConnections } from "./connections";
import { seedInstanceShippedSkills } from "./shipped-skills";

/**
 * What the API process writes before it takes a request: the Connections release config
 * defines and the skills the platform ships. A worker reads what is stored. A seed that fails
 * closes what the start had opened.
 */
export async function seedInstance(
  execution: Parameters<typeof seedInstanceShippedSkills>[0] & {
    connections?: InstanceConnections | undefined;
    close(): Promise<void>;
  }
): Promise<void> {
  try {
    await execution.connections?.seed();
    await seedInstanceShippedSkills(execution);
  } catch (error) {
    await execution.close();
    throw error;
  }
}
