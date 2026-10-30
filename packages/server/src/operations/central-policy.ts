import type { CentralPolicySetting } from "@work-shape/catalyst-core";
import type { ResolvedChatServerOptions } from "../types";

// Where the policy of a call reads the admin's choices (OP-2): what an admin set on Instance >
// Policies, stored per instance, and the locks of release config beside the screen's. Both are
// read for each call, so a value set a moment ago holds at once in every process.

type CentralPolicyOptions = Pick<
  ResolvedChatServerOptions,
  "clientInstanceId" | "stores" | "config" | "operations"
>;

/**
 * The central settings of the instance: those an admin set, and those a host's assembly names
 * in code (`operations.centralPolicySettings`). Of several that match a call the strictest wins,
 * so the two never loosen each other.
 */
export async function readCentralPolicySettings(
  options: CentralPolicyOptions
): Promise<CentralPolicySetting[]> {
  const [stored, named] = await Promise.all([
    options.stores.centralPolicySettings.list({ clientInstanceId: options.clientInstanceId }),
    options.operations?.centralPolicySettings?.() ?? []
  ]);
  return [
    ...stored.map(({ operation, value, workspaceId, assetKind }) => ({
      operation,
      value,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(assetKind === undefined ? {} : { assetKind })
    })),
    ...named
  ];
}

/**
 * The operations and patterns no person may "Always allow": the release config's locks and the
 * admin's of Instance > Policies. A lock only ever takes "Always allow" away.
 */
export async function readAlwaysAllowLocks(options: CentralPolicyOptions): Promise<string[]> {
  const stored = await options.stores.centralPolicySettings.listLocks({
    clientInstanceId: options.clientInstanceId
  });
  return [...options.config.policy.alwaysAllow.locked, ...stored.map((lock) => lock.operation)];
}
