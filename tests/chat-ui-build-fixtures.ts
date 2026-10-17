import type { PlatformContext } from "@work-shape/catalyst-api-client";
import { LEGACY_PERMISSION_ACTIONS, isPermission } from "@work-shape/catalyst-core";

export type Namespaces = PlatformContext["namespaces"];

/** The actions on agents and skills the instance names for a session with these legacy keys. */
export function instanceActions(permissions: readonly string[]): string[] {
  return permissions
    .filter(isPermission)
    .flatMap((permission) => [...LEGACY_PERMISSION_ACTIONS[permission]])
    .filter((action) => action.startsWith("agent.") || action.startsWith("skill."))
    .filter((action) => !action.endsWith(".approve"));
}

/**
 * What the instance answers a caller who holds the given Namespaces and, on the instance's
 * assets as a whole, the given actions.
 */
export function platformContext(
  namespaces: Namespaces = [],
  actions: string[] = [],
  assetActions: string[] = []
): PlatformContext {
  return {
    instance: { id: "client", name: "Catalyst" },
    release: { version: "1.4.0" },
    kinds: [
      {
        kind: "agent",
        plural: "agents",
        lifecycle: "active",
        representation: "config",
        owners: ["instance", "workspace"],
        actions: {
          read: "agent.read",
          write: "agent.write",
          publish: "agent.publish",
          delete: "agent.delete"
        }
      },
      {
        kind: "skill",
        plural: "skills",
        lifecycle: "active",
        representation: "config",
        owners: ["instance", "workspace"],
        actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" }
      }
    ],
    actions,
    assetActions,
    instanceActions: [],
    useActions: [],
    authoringActions: [],
    namespaces,
    workspaces: [],
    visibleSections: []
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
