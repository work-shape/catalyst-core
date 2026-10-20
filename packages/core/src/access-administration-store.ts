import type { ClientInstanceId } from "./ids";
import type { ScopeAssignmentInput } from "./data-scope";
import type { StorePage } from "./paging";
import type { AccessStore, GrantScopeAsset, PermissionGrant } from "./permissions";
import type { RightsLock } from "./rights-lock";

/** The store behind grants: the evaluator's port plus the administration writes. */
export interface AccessAdministrationStore extends AccessStore, RightsLock {
  listScopeAssignments(input: {
    clientInstanceId: ClientInstanceId;
    holderKind: ScopeAssignmentInput["holderKind"];
    holderId: string;
  }): Promise<ScopeAssignmentInput[]>;
  setScopeAssignment(
    input: ScopeAssignmentInput & { clientInstanceId: ClientInstanceId }
  ): Promise<void>;
  /** Non-admin people who inherit use through availability, with their own rows for the evaluator. */
  listAvailabilityMembers(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    action: string;
    page: StorePage;
  }): Promise<{ userId: UserId; displayLabel: string; grants: PermissionGrant[] }[]>;
  /**
   * Throws CONFLICT `duplicate_grant`, `userInDeletionError` for a user whose deletion was
   * requested, and NOT_FOUND `unknown_holder` for a service principal the instance does not have.
   */
  createGrant(input: Omit<PermissionGrant, "id" | "createdAt">): Promise<PermissionGrant>;
  getGrant(input: {
    clientInstanceId: ClientInstanceId;
    grantId: string;
  }): Promise<PermissionGrant | undefined>;
  deleteGrant(input: {
    clientInstanceId: ClientInstanceId;
    grantId: string;
  }): Promise<PermissionGrant | undefined>;
  listGrants(input: {
    clientInstanceId: ClientInstanceId;
    holderKind?: PermissionGrant["holderKind"];
    holderId?: string;
    action?: string;
    scopeKind?: PermissionGrant["scopeKind"];
    /** The asset or the workspace the rows name. */
    scopeId?: string;
    /** Leaves out the rows whose holder is a user with the superadmin role. */
    excludeSuperadminHolders?: boolean;
    /** Leaves out the rows whose holder is a service principal. */
    excludeServicePrincipalHolders?: boolean;
    /** Administration hides principals managed by their owning asset. */
    excludeOwnedPrincipalHolders?: boolean;
    /**
     * Leaves out the instance-wide rows of the actions a legacy key carries, which the legacy
     * permission lists show. An instance-wide row of any other action is listed.
     */
    excludeLegacyKeyRows?: boolean;
    page?: StorePage;
  }): Promise<PermissionGrant[]>;
  /** The active agent or skill an asset-scoped grant names. */
  getGrantableAsset(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<Omit<GrantScopeAsset, "active"> | undefined>;
  /**
   * The agents and skills behind asset scope ids, deleted ones included: a deny outlives the
   * asset it names, and whoever lists it has to say which name it still refuses.
   */
  listGrantScopeAssets(input: {
    clientInstanceId: ClientInstanceId;
    assetIds: readonly string[];
  }): Promise<GrantScopeAsset[]>;
}
