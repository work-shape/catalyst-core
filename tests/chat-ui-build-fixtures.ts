import type { PlatformContext } from "@vivd-catalyst/api-client";

export type Namespaces = PlatformContext["namespaces"];

/** What the instance answers a caller who holds the given Namespaces. */
export function platformContext(namespaces: Namespaces = []): PlatformContext {
  return {
    instance: { id: "client", name: "Catalyst" },
    release: { version: "1.4.0" },
    kinds: [
      {
        kind: "agent",
        plural: "agents",
        actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" }
      },
      {
        kind: "skill",
        plural: "skills",
        actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" }
      }
    ],
    namespaces
  };
}

/** Writes agents in the Namespace and only reads its skills. */
export const taxNamespace: Namespaces[number] = {
  prefix: "tax-",
  displayName: "Tax",
  actions: ["agent.read", "agent.write", "agent.delete", "skill.read"]
};
export const legalNamespace: Namespaces[number] = {
  prefix: "legal-",
  displayName: "Legal",
  actions: ["agent.read", "skill.read"]
};
