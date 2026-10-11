import type { DefinedClientInstance } from "@vivd-catalyst/client-assembly";

type Operations = NonNullable<
  NonNullable<Parameters<DefinedClientInstance["listen"]>[0]>["operations"]
>;

/**
 * The demo's one policy setting: a new or changed skill in the Namespace `hr-` waits for the
 * approval of another person. It gives the Inbox a registered operation to hold without a
 * model call, which `pnpm demo:seed` uses. No screen sets such a setting yet, so the demo's
 * server names it; without the Namespace `hr-` it matches nothing.
 */
export const demoOperations: Operations = {
  centralPolicySettings: () => [
    { operation: "assets.put", assetKind: "skill", namespace: "hr-", value: "approval" }
  ]
};
