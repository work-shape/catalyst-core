import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  hasAuthScope,
  type AccessResource,
  type ActorAccess,
  type AuthenticatedIdentity
} from "@work-shape/catalyst-core";
import { decide } from "../assets/asset-access";

/** The rights an entry of the list names, each with the scope of the calls it opens. */
const LISTED_ACTIONS = [
  { action: WORKFLOW_ACTIONS.read, scope: apiOperations["workflows.list_runs"].scope },
  { action: WORKFLOW_ACTIONS.use, scope: apiOperations["workflows.start"].scope }
] as const;

/** What a right on one Workflow is decided on: its name and, where it is stored, its asset. */
export const workflowOf = (name: string, assetId?: string): AccessResource => ({
  kind: WORKFLOW_ASSET_KIND,
  name,
  ...(assetId === undefined ? {} : { assetId })
});

/**
 * What `workflows.list` names of one published Workflow for this caller: the right on this
 * Workflow and a credential whose scope reaches the call. None leaves it off the list.
 */
export function listedWorkflowActions(
  access: ActorAccess,
  actor: AuthenticatedIdentity,
  workflow: AccessResource
): string[] {
  return LISTED_ACTIONS.filter(
    ({ action, scope }) => hasAuthScope(actor, scope) && decide(access, action, workflow).allowed
  ).map(({ action }) => action);
}
