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
    instance: { id: "client", name: "Catalyst", timeZone: "UTC", timeZoneDefaulted: true },
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

/**
 * What the instance answers a caller who holds these actions in these Shared Workspaces, by id,
 * and these on the instance's assets as a whole, where the instance runs Apps.
 */
export function appsContext(
  workspaces: Record<string, readonly string[]>,
  instance: string[] = []
): PlatformContext {
  const base = platformContext([], instance);
  return {
    ...base,
    kinds: [
      ...base.kinds,
      {
        kind: "app",
        plural: "apps",
        lifecycle: "active",
        representation: "files",
        owners: ["workspace"],
        actions: {
          read: "app.read",
          write: "app.write",
          publish: "app.publish",
          delete: "app.delete"
        }
      }
    ],
    workspaces: Object.entries(workspaces).map(([id, actions]) => ({
      id,
      name: id,
      kind: "shared" as const,
      member: true,
      actions: [...actions]
    }))
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

/**
 * What the instance answers a caller who holds these actions on the instance's own assets as a
 * whole, these on single assets, and these in these Shared Workspaces, by id, where the
 * instance runs Workflows. The instance keeps Workflows on itself, so it names no Workflow
 * action in a workspace today; a test that names one there stands for a kind a workspace owns.
 */
export function workflowsContext(
  actions: string[],
  workspaces: Record<string, readonly string[]> = {},
  assetActions: string[] = []
): PlatformContext {
  const base = platformContext([], actions, assetActions);
  return {
    ...base,
    kinds: [
      ...base.kinds,
      {
        kind: "workflow",
        plural: "workflows",
        lifecycle: "draft_published",
        representation: "config",
        owners: ["instance"],
        actions: {
          read: "workflow.read",
          write: "workflow.write",
          publish: "workflow.publish",
          delete: "workflow.delete"
        }
      }
    ],
    workspaces: Object.entries(workspaces).map(([id, held]) => ({
      id,
      name: id,
      kind: "shared" as const,
      member: true,
      actions: [...held]
    }))
  };
}
