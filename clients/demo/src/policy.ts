import type { DefinedClientInstance } from "@vivd-catalyst/client-assembly";

type Operations = NonNullable<
  NonNullable<Parameters<DefinedClientInstance["listen"]>[0]>["operations"]
>;

/**
 * The demo's one policy setting. A new or changed skill that is saved through `assets.put`
 * into the registered Namespace `hr-` is held for an approval, for every caller, admins and
 * the superadmin included. It holds nothing else: not a delete, not a revert, not a push of
 * the config CLI, and nothing at all while no Namespace `hr-` is registered. Whoever holds
 * `operations.approve` decides a held call, the caller too if they hold it.
 *
 * It gives the Inbox a registered operation to hold without a model call, which
 * `pnpm demo:seed` uses. No screen sets such a setting yet, so the demo's server names it.
 */
export const demoOperations: Operations = {
  centralPolicySettings: () => [
    { operation: "assets.put", assetKind: "skill", namespace: "hr-", value: "approval" }
  ]
};
