import {
  createActorAccess,
  isMembershipOnlyAction,
  listAccessEntries,
  type AccessEntry,
  type AccessHolder,
  type CollaborationWorkspaceStore,
  type GrantScopeAsset,
  type HeldRight,
  type PermissionGrant,
  type UserRecord
} from "@work-shape/catalyst-core";
import { assetRight, type PrincipalRightsOptions } from "./principal-rights";

/** What a person's rights are read from: the rows, and the workspaces to tell their own one. */
export interface PersonRightsOptions extends PrincipalRightsOptions {
  workspaces: Pick<CollaborationWorkspaceStore, "listWorkspacesForUser">;
}

/** Where a row or an entry holds its action: the scope fields both carry. */
type ScopedRight = Pick<AccessEntry, "action" | "scopeKind" | "scopeId">;

/**
 * Every right a person holds, as whoever changes the person's account must hold it: each role
 * default and instance-wide row as its action, each row in a workspace or on one asset on that
 * resource, each membership of a Shared Workspace as the rights it carries
 * there, and each reference of a tool as the action `ref:<reference>`. A right a deny of the
 * person takes away is left out. The person's own Personal Workspace is the account itself, which
 * every account has and nobody gives, so its membership is not asked. Nor are a project's
 * rights: membership alone carries them and nobody else can hold them, so whoever may change
 * the account's memberships changes them (PRJ-1).
 *
 * The person counts as active: a disabled account holds its rights again once enabled, and
 * enabling it is a change of the account like any other.
 */
export async function personRights(
  options: PersonRightsOptions,
  person: Pick<UserRecord, "id" | "clientInstanceId" | "roles" | "permissionRefs">
): Promise<HeldRight[]> {
  const [loaded, workspaces] = await Promise.all([
    options.access.loadPersistedAccess({
      clientInstanceId: options.clientInstanceId,
      holder: { kind: "user", id: person.id }
    }),
    options.workspaces.listWorkspacesForUser({
      clientInstanceId: options.clientInstanceId,
      userId: person.id
    })
  ]);
  const own = new Set<string>(
    workspaces.filter((workspace) => workspace.kind === "personal").map((workspace) => workspace.id)
  );
  const persisted = {
    ...loaded,
    memberWorkspaceIds: (loaded.memberWorkspaceIds ?? []).filter((id) => !own.has(id)),
    holderActive: true
  };
  const holder: AccessHolder = {
    kind: "user",
    id: person.id,
    clientInstanceId: person.clientInstanceId,
    roles: person.roles,
    permissionRefs: person.permissionRefs
  };
  const allows = listAccessEntries(holder, persisted).filter(
    (entry) => entry.effect === "allow" && !isMembershipOnlyAction(entry.action)
  );
  const assets = await scopeAssets(options, allows);
  const held = createActorAccess(holder, persisted);
  const rights = new Map<string, HeldRight>();
  for (const entry of allows) {
    const right = rightAtScope(entry, assets);
    if (held.authorize(right.action, right.resource).allowed) {
      rights.set(JSON.stringify(right), right);
    }
  }
  return [...rights.values()];
}

/**
 * The right a row or an entry names, on the resource of its scope: an asset by kind, name, id
 * and owner where the store knows it and by its id alone where not, a workspace by its id, and
 * the whole instance as no resource.
 */
export function rightAtScope(
  row: ScopedRight,
  assets: ReadonlyMap<string, Pick<GrantScopeAsset, "id" | "kind" | "name" | "workspaceId">>
): HeldRight {
  const { action, scopeId } = row;
  switch (row.scopeKind) {
    case "asset": {
      const asset = scopeId === undefined ? undefined : assets.get(scopeId);
      if (asset) return assetRight(action, asset);
      return { action, resource: { assetId: scopeId ?? "" } };
    }
    case "workspace":
      return { action, resource: { workspaceId: scopeId ?? "" } };
    default:
      return { action };
  }
}

/** The assets the asset-scope rows name, by id, deleted ones included. */
export async function scopeAssets(
  options: PrincipalRightsOptions,
  rows: readonly Pick<PermissionGrant, "scopeKind" | "scopeId">[]
): Promise<ReadonlyMap<string, GrantScopeAsset>> {
  const assetIds = rows.flatMap((row) =>
    row.scopeKind === "asset" && row.scopeId !== undefined ? [row.scopeId] : []
  );
  if (assetIds.length === 0) return new Map();
  const assets = await options.access.listGrantScopeAssets({
    clientInstanceId: options.clientInstanceId,
    assetIds
  });
  return new Map(assets.map((asset) => [asset.id, asset]));
}
