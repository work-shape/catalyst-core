import type {
  WORKFLOW_RIGHT_NEEDED_FOR,
  WORKFLOW_RIGHT_REFUSALS,
  WORKFLOW_RIGHTS_REVISIONS,
  WORKFLOW_RUN_ACCOUNT_STATUSES
} from "@work-shape/catalyst-asset-schemas";
import type { ActorAccess, AccessResource } from "./permissions";

/**
 * When the run account of a Workflow needs a right its definition names. `publish`: the
 * publish is refused without it, as a child Workflow is started by the parent's account.
 * `run`: the publish passes and the step that needs it fails when it runs.
 */
export type WorkflowRightNeededFor = (typeof WORKFLOW_RIGHT_NEEDED_FOR)[number];

/** The revision of a Workflow of a publish the rights are read from. */
export type WorkflowRightsRevision = (typeof WORKFLOW_RIGHTS_REVISIONS)[number];

/** Why a reader cannot give an account a right it lacks (`WORKFLOW_RIGHT_REFUSALS`). */
export type WorkflowRightRefusal = (typeof WORKFLOW_RIGHT_REFUSALS)[number];

/** One asset a needed right is on, as the definition names it. */
export interface WorkflowNeededRightAsset {
  kind: string;
  name: string;
  /** The asset's id, where an asset of the name exists. A grant names it. */
  assetId?: string;
  /** The workspace that owns the asset; absent for an instance-owned asset. */
  workspaceId?: string;
}

/**
 * A right the account a Workflow runs as (`runAs`) needs on one asset, because a step of the
 * definition calls something that asks it. Derived from the definition alone: the publish
 * check and the publish screen read the same list (`workflowNeededRights`).
 */
export interface WorkflowNeededRight {
  action: string;
  asset: WorkflowNeededRightAsset;
  /** The ids of the steps that need it, in the order of the definition. */
  steps: string[];
  neededFor: WorkflowRightNeededFor;
}

/** The resource a needed right is decided on, as the evaluator reads one. */
export function workflowNeededRightResource(right: WorkflowNeededRight): AccessResource {
  return {
    kind: right.asset.kind,
    name: right.asset.name,
    ...(right.asset.assetId === undefined ? {} : { assetId: right.asset.assetId }),
    ...(right.asset.workspaceId === undefined ? {} : { workspaceId: right.asset.workspaceId })
  };
}

/** Of the needed rights, those the account's access does not allow. */
export function workflowRightsLacking(
  rights: readonly WorkflowNeededRight[],
  access: Pick<ActorAccess, "authorize">
): WorkflowNeededRight[] {
  return rights.filter(
    (right) => !access.authorize(right.action, workflowNeededRightResource(right)).allowed
  );
}

/** How the account a Workflow names under `runAs` stands on the instance. */
export type WorkflowRunAccountStatus = (typeof WORKFLOW_RUN_ACCOUNT_STATUSES)[number];

/**
 * The rights one Workflow of a publish needs and whether its account holds them: the Workflow
 * published, or a child it starts, each with its own account.
 */
export interface WorkflowAccountRights {
  /** The id of the Workflow. */
  workflow: string;
  /** `draft` for the revision being published, `published` for a child that is live. */
  revision: WorkflowRightsRevision;
  /** The name of the account in the definition. */
  runAs: string;
  account?: { id: string; label: string; status: Exclude<WorkflowRunAccountStatus, "unknown"> };
  rights: (WorkflowNeededRight & { held: boolean })[];
}
