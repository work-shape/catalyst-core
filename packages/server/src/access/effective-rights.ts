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
  type AppAudience,
  type AppAvailability,
  type AssetKindRegistry,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConfigAssetStore,
  type GrantScopeAsset,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { assetTitle } from "../assets/asset-reference-labels";

// What a holder's entries come to, decided by the evaluator (`evaluateAccess`) on the server,
// with the entry `explainAccessEntries` names as where it comes from, so a screen shows the
// decision every call is decided by and never decides itself (AP-5b2). Nothing here writes.

/** What a right on one asset is decided on beside the entries: its owner and its audience. */
export interface AssetFacts {
  workspaceId?: string;
  appAvailability?: AppAvailability;
}

/** The holder's evaluator, and where availability gives the holder an asset's use. */
export interface Deciding {
  /** The decision every call of the holder is decided by. */
  evaluate(action: string, resource: AccessResource | undefined): AccessDecision;
  /**
   * The workspaces in which an asset's availability gives the holder its use: a call narrowed
   * to another workspace, or to none, is refused it.
   */
  availableIn(assetId: string): readonly string[];
}

/** What decides one right, beside the entry that gives or refuses it. */
interface Conditions {
  /** The App's audience decided, where the entries alone came to the other answer. */
  availability?: AppAudience;
  /** The right holds only while the holder works in one of these workspaces. */
  onlyIn?: readonly string[];
}

/** One right at the place an entry names it, decided, with the entries that decide it. */
export interface DecidedRight extends Conditions {
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

type CheckedVerb = (typeof ASSET_CHECK_VERBS)[number];

/** One right of a kind on one asset, decided, with the entry that decides it. */
export interface DecidedAssetAction extends Conditions {
  verb: CheckedVerb;
  action: string;
  allowed: boolean;
  reason?: RefusalReason;
  /** The covering deny that refuses, or the allow that gives it. */
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

/** The use an asset's availability gives through a membership: it holds in some workspaces. */
function isAvailabilityUse(entry: AccessEntry): boolean {
  return entry.source === "membership" && entry.scopeKind === "asset";
}

/** The entries alone, for a reader with no store behind it: no availability and no App. */
function entriesDeciding(entries: readonly AccessEntry[]): Deciding {
  const granting = grantingEntries(entries);
  return {
    evaluate: (action, resource) => explainAccessEntries(granting, action, resource).decision,
    availableIn: () => []
  };
}

/** The resource an entry's own place stands for, with what is known of an asset there. */
function resourceAt(
  entry: Pick<AccessEntry, "scopeKind" | "scopeId">,
  assetOf: (assetId: string) => AssetFacts | undefined
): AccessResource | undefined {
  if (entry.scopeId === undefined) return undefined;
  if (entry.scopeKind === "workspace") return { workspaceId: entry.scopeId };
  if (entry.scopeKind === "asset") {
    const facts = assetOf(entry.scopeId);
    return {
      assetId: entry.scopeId,
      ...(facts?.workspaceId === undefined ? {} : { workspaceId: facts.workspaceId }),
      ...(facts?.appAvailability === undefined ? {} : { appAvailability: facts.appAvailability })
    };
  }
  return undefined;
}

interface Decided extends Conditions {
  allowed: boolean;
  reason?: RefusalReason;
  decidedBy?: AccessEntry;
}

function refusalOf(decision: AccessDecision): RefusalReason {
  if (decision.allowed) return "no_grant";
  if (decision.reason === "holder_inactive") return "holder_inactive";
  return decision.reason === "denied" ? "denied" : "no_grant";
}

/**
 * One right on one resource. The evaluator decides; the entry it comes from is the covering
 * deny, or an allow that holds everywhere before one that holds only where the asset is
 * available. Where the App's availability, and not the entries, decided, that is said.
 */
function decideOne(
  granting: readonly AccessEntry[],
  holderActive: boolean,
  action: string,
  resource: AccessResource | undefined,
  deciding: Deciding
): Decided {
  if (!holderActive) return { allowed: false, reason: "holder_inactive" };
  const explained = explainAccessEntries(granting, action, resource);
  const decision = deciding.evaluate(action, resource);
  const audience = resource?.appAvailability?.audience;
  if (decision.allowed !== explained.decision.allowed) {
    return {
      allowed: decision.allowed,
      ...(decision.allowed ? {} : { reason: refusalOf(decision) }),
      ...(audience === undefined ? {} : { availability: audience })
    };
  }
  const entry = explained.entry;
  if (!decision.allowed) {
    return {
      allowed: false,
      reason: refusalOf(decision),
      ...(entry === undefined ? {} : { decidedBy: entry })
    };
  }
  if (entry === undefined || !isAvailabilityUse(entry)) {
    return { allowed: true, ...(entry === undefined ? {} : { decidedBy: entry }) };
  }
  const firm = explainAccessEntries(
    granting.filter((candidate) => !isAvailabilityUse(candidate)),
    action,
    resource
  );
  return firm.decision.allowed && firm.entry !== undefined
    ? { allowed: true, decidedBy: firm.entry }
    : {
        allowed: true,
        decidedBy: entry,
        onlyIn: entry.scopeId === undefined ? [] : deciding.availableIn(entry.scopeId)
      };
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
  assetOf: (assetId: string) => AssetFacts | undefined,
  deciding: Deciding = entriesDeciding(entries)
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
    const { decidedBy, ...decision } = decideOne(
      granting,
      holderActive,
      action,
      resourceAt(first, assetOf),
      deciding
    );
    const deniedBy = decidedBy?.effect === "deny" ? decidedBy : undefined;
    return {
      action,
      scopeKind,
      ...(scopeId === undefined ? {} : { scopeId }),
      ...decision,
      grantedBy: own.filter((entry) => entry.effect === "allow"),
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
  resource: AccessResource,
  deciding: Deciding = entriesDeciding(entries)
): DecidedAssetAction[] {
  const granting = grantingEntries(entries);
  const decided = ASSET_CHECK_VERBS.flatMap((verb): DecidedAssetAction[] => {
    const action = actions[verb];
    if (action === undefined) return [];
    return [{ verb, action, ...decideOne(granting, holderActive, action, resource, deciding) }];
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
  scopeAsset?: { kind: string; name?: string; title?: string; active: boolean };
  scopeWorkspace?: { personal: boolean; name?: string };
}

interface NamingOptions {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "access" | "workspaces" | "roles"> & {
    configAssets: Pick<ConfigAssetStore, "listConfigAssetsByKey">;
  };
  kinds: AssetKindRegistry;
}

/**
 * The names of the places that the entries name, as the caller may read them, and what a right
 * on an asset is decided on beside them. An asset's name and title are left out for a caller
 * who may not read every asset of its kind, as on a grant row. A workspace's name is left out for a caller who neither administers people nor
 * is a member of it; whether it is a Personal Workspace is said either way.
 */
export async function namePlaces(
  options: NamingOptions,
  caller: { actor: AuthenticatedUser; access: ActorAccess },
  places: readonly Pick<AccessEntry, "scopeKind" | "scopeId">[]
): Promise<{
  assets: ReadonlyMap<string, GrantScopeAsset>;
  factsOf(assetId: string): AssetFacts | undefined;
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
  // The revisions of the active assets, for the title people read and an App's availability.
  const active = assets.filter((asset) => asset.active);
  const records = new Map(
    (active.length === 0
      ? []
      : await options.stores.configAssets.listConfigAssetsByKey({
          clientInstanceId: options.clientInstanceId,
          keys: active.map((asset) => ({ kind: asset.kind, name: asset.name }))
        })
    )
      .filter((record) => assetById.has(record.id))
      .map((record) => [record.id, record])
  );
  const administers = caller.access.authorize("users.manage").allowed;
  const callerIn = new Set(callerWorkspaces.map((workspace) => String(workspace.id)));
  const workspaceById = new Map(
    workspaces.flatMap((workspace) => (workspace ? [[String(workspace.id), workspace]] : []))
  );
  return {
    assets: assetById,
    factsOf(assetId) {
      const asset = assetById.get(assetId);
      if (asset === undefined) return undefined;
      const availability = records.get(assetId)?.appAvailability;
      return {
        ...(asset.workspaceId === undefined ? {} : { workspaceId: asset.workspaceId }),
        ...(availability === undefined ? {} : { appAvailability: availability })
      };
    },
    placeOf(place) {
      if (place.scopeId === undefined) return {};
      if (place.scopeKind === "asset") {
        const asset = assetById.get(place.scopeId);
        if (asset === undefined) return {};
        const readAction = options.kinds.get(asset.kind)?.actions.read;
        const named = readAction !== undefined && caller.access.authorize(readAction).allowed;
        const record = records.get(asset.id);
        const config = record?.publishedConfig ?? record?.config;
        const title =
          named && config
            ? assetTitle(options.kinds.kinds, asset.kind, asset.name, config, undefined)
            : undefined;
        return {
          scopeAsset: {
            kind: asset.kind,
            ...(named ? { name: asset.name } : {}),
            ...(title === undefined || title === asset.name ? {} : { title }),
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
