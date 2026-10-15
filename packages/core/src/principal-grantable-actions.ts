import type { PlatformAction } from "@work-shape/catalyst-asset-schemas";

/**
 * The rights a grant row can give a service principal: the use rights of a resource and
 * nothing else. No right that writes, publishes, deletes or manages is here, and none over
 * users, access or API access. A kind adds its use right when it brings one; the grant write
 * hands out only those of them a kind of the instance registers. The list limits what the
 * grant operation writes; the evaluator answers from whatever rows the table holds.
 */
export const PRINCIPAL_GRANTABLE_ACTIONS = [
  "connection.use",
  "data_store.read",
  "data_store.insert",
  "data_store.execute",
  "knowledge_base.use",
  "workflow.use"
] as const satisfies readonly PlatformAction[];

export type PrincipalGrantableAction = (typeof PRINCIPAL_GRANTABLE_ACTIONS)[number];

export function isPrincipalGrantableAction(action: string): action is PrincipalGrantableAction {
  return PRINCIPAL_GRANTABLE_ACTIONS.some((candidate) => candidate === action);
}
