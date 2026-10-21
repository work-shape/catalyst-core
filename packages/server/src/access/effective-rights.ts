import { ASSET_CHECK_VERBS, type RefusalReason } from "@work-shape/catalyst-api-contract";
import {
  ACTIONS,
  BUILT_IN_ROLES,
  asCollaborationWorkspaceId,
  asUserId,
  explainAccessEntries,
  isBuiltInRole,
  type AccessDecision,
  type AccessEntry,
  type AccessResource,
  type ActorAccess,
  type AssetKindRegistry,
  type AuthenticatedUser,
  type ClientInstanceId,
  type GrantScopeAsset,
  type PlatformStores
} from "@work-shape/catalyst-core";

// What a holder's entries come to, decided by the evaluator's own rule (`explainAccessEntries`)
// on the server, so a screen shows the decision with where it comes from and never decides
// itself (AP-5b2). Nothing here writes.

/** One right at the place an entry names it, decided, with the entries that decide it. */
export interface DecidedRight {
  action: string;
  scopeKind: AccessEntry["scopeKind"];
  scopeId?: string;
  allowed: boolean;
  reason?: RefusalReason;
  /** Every allow at exactly this place: where the right comes from. */
  grantedBy: AccessEntry[];
  /** The covering deny that refuses it here; it can lie at a wider place. */
  deniedBy?: AccessEntry;
}

function refusalOf(holderActive: boolean, decision: AccessDecision): RefusalReason {
  if (!holderActive) return "holder_inactive";
  return !decision.allowed && decision.reason === "denied" ? "denied" : "no_grant";
}

type CheckedVerb = (typeof ASSET_CHECK_VERBS)[number];

/** One right of a kind on one asset, decided, with the entry that decides it. */
export interface DecidedAssetAction {
  verb: CheckedVerb;
  action: string;
  allowed: boolean;
  reason?: RefusalReason;
  /** The covering deny that refuses, or the first covering allow. */
  decidedBy?: AccessEntry;
  /** For a delete refused because reading or writing the asset is denied. */
  deniedThrough?: CheckedVerb;
}

const SCOPE_RANK: Record<AccessEntry["scopeKind"], number> = {
  instance: 0,
  workspace: 1,
  asset: 2
};

/**
 * A reference is decided from the holder's own list and no role, row or deny names one; it
 * is shown where it is set, on the person, and never as a right here.
 */
function grantingEntries(entries: readonly AccessEntry[]): AccessEntry[] {
  return entries.filter((entry) => entry.source !== "legacy_ref");
}

/** The resource an entry's own place stands for, with the workspace that owns an asset. */
function resourceAt(
  entry: Pick<AccessEntry, "scopeKind" | "scopeId">,
  workspaceOfAsset: (assetId: string) => string | undefined
): AccessResource | undefined {
  if (entry.scopeId === undefined) return undefined;
  if (entry.scopeKind === "workspace") return { workspaceId: entry.scopeId };
  if (entry.scopeKind === "asset") {
    const workspaceId = workspaceOfAsset(entry.scopeId);
    return { assetId: entry.scopeId, ...(workspaceId === undefined ? {} : { workspaceId }) };
  }
  return undefined;
}

/**
 * Every right a holder's entries name, each at its own place and decided there: an allow
 * that a covering deny refuses is listed refused, with the deny. A deny that takes nothing
 * away is listed on its own place. An inactive holder holds nothing, whatever the entries say.
 * Ordered by the release's actions, then from the instance down to one asset.
 */
export function decideHeldRights(
  entries: readonly AccessEntry[],
  holderActive: boolean,
  workspaceOfAsset: (assetId: string) => string | undefined
): DecidedRight[] {
  const granting = grantingEntries(entries);
  const places = new Map<string, { first: AccessEntry; own: AccessEntry[] }>();
  for (const entry of granting) {
    const key = [entry.action, entry.scopeKind, entry.scopeId ?? ""].join("\u0000");
    const place = places.get(key);
    if (place) place.own.push(entry);
    else places.set(key, { first: entry, own: [entry] });
  }
  const decided = [...places.values()].map(({ first, own }): DecidedRight => {
    const { action, scopeKind, scopeId } = first;
    const explained = explainAccessEntries(granting, action, resourceAt(first, workspaceOfAsset));
    const grantedBy = own.filter((entry) => entry.effect === "allow");
    const deniedBy = explained.decision.allowed ? undefined : explained.entry;
    const allowed = holderActive && explained.decision.allowed;
    return {
      action,
      scopeKind,
      ...(scopeId === undefined ? {} : { scopeId }),
      allowed,
      ...(allowed ? {} : { reason: refusalOf(holderActive, explained.decision) }),
      grantedBy,
      ...(deniedBy === undefined ? {} : { deniedBy })
    };
  });
  const position = (action: string) => {
    const index = ACTIONS.findIndex((candidate) => candidate === action);
    return index < 0 ? ACTIONS.length : index;
  };
  return decided.sort(
    (left, right) =>
      position(left.action) - position(right.action) ||
      left.action.localeCompare(right.action) ||
      SCOPE_RANK[left.scopeKind] - SCOPE_RANK[right.scopeKind] ||
      (left.scopeId ?? "").localeCompare(right.scopeId ?? "")
  );
}

/**
 * Each checked verb the kind names, decided on one asset. Whoever is denied reading or
 * writing an asset does not delete it, so such a deny refuses an allowed delete as well.
 */
export function decideAssetActions(
  entries: readonly AccessEntry[],
  holderActive: boolean,
  actions: Readonly<Partial<Record<string, string>>>,
  resource: AccessResource
): DecidedAssetAction[] {
  const granting = grantingEntries(entries);
  const decided = ASSET_CHECK_VERBS.flatMap((verb): DecidedAssetAction[] => {
    const action = actions[verb];
    if (action === undefined) return [];
    if (!holderActive) return [{ verb, action, allowed: false, reason: "holder_inactive" }];
    const { decision, entry } = explainAccessEntries(granting, action, resource);
    const decidedBy = entry === undefined ? {} : { decidedBy: entry };
    return [
      decision.allowed
        ? { verb, action, allowed: true, ...decidedBy }
        : {
            verb,
            action,
            allowed: false,
            reason: decision.reason === "denied" ? "denied" : "no_grant",
            ...decidedBy
          }
    ];
  });
  return decided.map((checked) => {
    if (checked.verb !== "delete" || !checked.allowed) return checked;
    const deny = decided.find(
      (other) => (other.verb === "read" || other.verb === "write") && other.reason === "denied"
    );
    return deny
      ? {
          verb: "delete",
          action: checked.action,
          allowed: false,
          reason: "denied",
          ...(deny.decidedBy === undefined ? {} : { decidedBy: deny.decidedBy }),
          deniedThrough: deny.verb
        }
      : checked;
  });
}

/** A role an origin names. */
export interface OriginRole {
  id: string;
  name: string;
  builtIn: boolean;
}

/** What a caller is shown of the places a list of entries names. */
export interface PlaceNames {
  scopeAsset?: { kind: string; name?: string; active: boolean };
  scopeWorkspace?: { personal: boolean; name?: string };
}

interface NamingOptions {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "access" | "workspaces" | "roles">;
  kinds: AssetKindRegistry;
}

/**
 * The names of the places and roles that the entries name, as the caller may read them. An
 * asset's name is left out for a caller who may not read every asset of its kind, as on a
 * grant row. A workspace's name is left out for a caller who neither administers people nor
 * is a member of it; whether it is a Personal Workspace is said either way.
 */
export async function namePlaces(
  options: NamingOptions,
  caller: { actor: AuthenticatedUser; access: ActorAccess },
  places: readonly Pick<AccessEntry, "scopeKind" | "scopeId">[]
): Promise<{
  assets: ReadonlyMap<string, GrantScopeAsset>;
  placeOf(place: Pick<AccessEntry, "scopeKind" | "scopeId">): PlaceNames;
}> {
  const ids = (kind: AccessEntry["scopeKind"]) => [
    ...new Set(
      places.flatMap((place) =>
        place.scopeKind === kind && place.scopeId !== undefined ? [place.scopeId] : []
      )
    )
  ];
  const workspaceIds = ids("workspace");
  const [assets, workspaces, callerWorkspaces] = await Promise.all([
    options.stores.access.listGrantScopeAssets({
      clientInstanceId: options.clientInstanceId,
      assetIds: ids("asset")
    }),
    Promise.all(
      workspaceIds.map((id) =>
        options.stores.workspaces.getWorkspace(
          options.clientInstanceId,
          asCollaborationWorkspaceId(id)
        )
      )
    ),
    workspaceIds.length === 0
      ? []
      : options.stores.workspaces.listWorkspacesForUser({
          clientInstanceId: options.clientInstanceId,
          userId: asUserId(caller.actor.id)
        })
  ]);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const administers = caller.access.authorize("users.manage").allowed;
  const callerIn = new Set(callerWorkspaces.map((workspace) => String(workspace.id)));
  const workspaceById = new Map(
    workspaces.flatMap((workspace) => (workspace ? [[String(workspace.id), workspace]] : []))
  );
  return {
    assets: assetById,
    placeOf(place) {
      if (place.scopeId === undefined) return {};
      if (place.scopeKind === "asset") {
        const asset = assetById.get(place.scopeId);
        if (asset === undefined) return {};
        const readAction = options.kinds.get(asset.kind)?.actions.read;
        const named = readAction !== undefined && caller.access.authorize(readAction).allowed;
        return {
          scopeAsset: {
            kind: asset.kind,
            ...(named ? { name: asset.name } : {}),
            active: asset.active
          }
        };
      }
      if (place.scopeKind === "workspace") {
        const workspace = workspaceById.get(place.scopeId);
        if (workspace === undefined) return {};
        const named = administers || callerIn.has(place.scopeId);
        return {
          scopeWorkspace: {
            personal: workspace.kind === "personal",
            ...(named ? { name: workspace.name } : {})
          }
        };
      }
      return {};
    }
  };
}

/**
 * The roles the entries are held through, by their names. A built-in role is named by its id,
 * which the interface has words for; a custom role by the name it was given.
 */
export async function nameRoles(
  options: Pick<NamingOptions, "clientInstanceId" | "stores">,
  entries: readonly (AccessEntry | undefined)[]
): Promise<OriginRole[]> {
  const ids = [
    ...new Set(
      entries.flatMap((entry) =>
        entry?.source === "role" && entry.roleId !== undefined ? [entry.roleId] : []
      )
    )
  ];
  if (ids.length === 0) return [];
  const stored = ids.every(isBuiltInRole)
    ? []
    : await options.stores.roles.listRoles({ clientInstanceId: options.clientInstanceId });
  const rank = (id: string) => {
    const index = BUILT_IN_ROLES.findIndex((role) => role === id);
    return index < 0 ? BUILT_IN_ROLES.length : index;
  };
  return ids
    .map((id): OriginRole => {
      if (isBuiltInRole(id)) return { id, name: id, builtIn: true };
      const role = stored.find((candidate) => candidate.id === id);
      return { id, name: role?.name ?? id, builtIn: false };
    })
    .sort((left, right) => rank(left.id) - rank(right.id) || left.name.localeCompare(right.name));
}
