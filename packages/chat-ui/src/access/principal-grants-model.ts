import type {
  AdministeredUser,
  AssetSummary,
  CreatePermissionGrantRequest,
  PermissionGrantRow,
  PlatformContext,
  ServicePrincipalDetail
} from "@vivd-catalyst/api-client";
import { accessWriteFailure, refusalReason } from "./access-model";

// The rights of a service principal on named resources, as two pages show them: the
// principal's own page lists what it was given, and a resource's page lists who holds a right
// on it. Everything here is told by the instance: which rights can be given comes with the
// platform context, never from a list kept in the interface.

/** A kind a service principal can be given rights on, with the rights the instance hands out. */
export interface PrincipalGrantKind {
  kind: string;
  actions: string[];
}

export function principalGrantKinds(
  context: Pick<PlatformContext, "kinds"> | undefined
): PrincipalGrantKind[] {
  return (context?.kinds ?? []).flatMap((kind) =>
    kind.principalActions && kind.principalActions.length > 0
      ? [{ kind: kind.kind, actions: [...kind.principalActions] }]
      : []
  );
}

/** The write was accepted and waits for somebody else's approval: nothing changed yet. */
export class PrincipalGrantHeldError extends Error {}

/** How giving or removing a right failed, as far as the page has a sentence for it. */
export type PrincipalGrantFailure =
  /** The reader may not administer service principals. */
  | "notAdministrable"
  /** The right is none a service principal can hold. */
  | "actionNotGrantable"
  /** The resource is gone, of another kind, or no single resource was named. */
  | "invalidScope"
  /** A service principal is allowed a right and never denied one. */
  | "effectNotGrantable"
  | "duplicate"
  | "unknownHolder"
  | "held"
  | "other";

export function principalGrantFailure(error: unknown): PrincipalGrantFailure {
  if (error instanceof PrincipalGrantHeldError) {
    return "held";
  }
  switch (refusalReason(error)) {
    case "holder_not_administrable":
      return "notAdministrable";
    case "action_not_grantable_to_principal":
      return "actionNotGrantable";
    case "effect_not_grantable_to_principal":
      return "effectNotGrantable";
    case "invalid_scope":
      return "invalidScope";
    default:
      break;
  }
  const failure = accessWriteFailure(error);
  return failure === "duplicateGrant"
    ? "duplicate"
    : failure === "unknownHolder"
      ? "unknownHolder"
      : "other";
}

/** The one row a right for a principal is: allowed, on one named resource. */
export function principalGrantRequest(input: {
  principalId: string;
  action: string;
  assetId: string;
}): CreatePermissionGrantRequest {
  return {
    holderKind: "service_principal",
    holderId: input.principalId,
    action: input.action,
    effect: "allow",
    scopeKind: "asset",
    scopeId: input.assetId
  };
}

/** Whom a resource belongs to, as a row says it. */
type ResourcePlace = { kind: "instance" } | { kind: "workspace"; name: string | undefined };

/** One right of a principal as its page lists it. */
export interface PrincipalGrantView {
  grant: PermissionGrantRow;
  /** The kind of the resource, where the instance still knows the resource. */
  kind: string | undefined;
  /** The name people read, else the resource's id, else nothing: the reader may not see it. */
  title: string | undefined;
  /** The resource's id, where it differs from the title. */
  name: string | undefined;
  place: ResourcePlace | undefined;
  /** The resource was deleted: the right allows nothing any more. */
  gone: boolean;
  grantedBy: string | undefined;
}

interface PrincipalGrantLookups {
  /** The resources the reader is shown, of every kind a right can name. */
  assets: readonly AssetSummary[];
  workspaces: readonly { id: string; name: string }[];
  users: readonly Pick<AdministeredUser, "id" | "displayLabel">[];
}

export function principalGrantViews(
  grants: readonly PermissionGrantRow[],
  lookups: PrincipalGrantLookups
): PrincipalGrantView[] {
  return grants
    .filter((grant) => grant.holderKind === "service_principal")
    .map((grant) => {
      const asset = lookups.assets.find((candidate) => candidate.id === grant.scopeId);
      const name = asset?.name ?? grant.scopeAsset?.name;
      const title = asset?.title.trim() || name;
      const scope = asset?.scope;
      return {
        grant,
        kind: asset?.kind ?? grant.scopeAsset?.kind,
        title,
        name: name === title ? undefined : name,
        place:
          scope === undefined
            ? undefined
            : scope.kind === "workspace"
              ? {
                  kind: "workspace" as const,
                  name: lookups.workspaces.find(({ id }) => id === scope.workspaceId)?.name
                }
              : { kind: "instance" as const },
        gone: grant.scopeAsset?.active === false,
        grantedBy: lookups.users.find(({ id }) => id === grant.grantedBy)?.displayLabel
      };
    });
}

/** The resources of one kind the dialog offers: the ones the principal holds `action` on are left out. */
export function grantableResources(
  assets: readonly AssetSummary[],
  input: { kind: string; action: string | undefined; held: readonly PermissionGrantRow[] }
): AssetSummary[] {
  const taken = new Set(
    input.held.filter((grant) => grant.action === input.action).map((grant) => grant.scopeId)
  );
  return assets.filter((asset) => asset.kind === input.kind && !taken.has(asset.id));
}

/** Who holds a right on one resource: a person, or a service principal. */
export interface ResourceHolder {
  grantId: string;
  kind: "person" | "service_principal";
  id: string;
  /** Absent for a holder the reader's lists do not name. */
  name: string | undefined;
  /** The person's address or the principal's id. */
  detail: string | undefined;
  /** A disabled principal holds the right and can use nothing while it is disabled. */
  disabled: boolean;
}

/**
 * The holders of `action` on one resource, from the rows that name the resource itself.
 * People first, then service principals, each by name. A deny is no holder.
 */
export function resourceHolders(
  grants: readonly PermissionGrantRow[],
  input: {
    action: string;
    users: readonly Pick<AdministeredUser, "id" | "displayLabel" | "email">[];
    principals: readonly ServicePrincipalDetail[];
  }
): ResourceHolder[] {
  const seen = new Set<string>();
  const holders = grants.flatMap((grant): ResourceHolder[] => {
    const key = `${grant.holderKind}:${grant.holderId}`;
    if (grant.action !== input.action || grant.effect !== "allow" || seen.has(key)) {
      return [];
    }
    if (grant.holderKind === "user") {
      seen.add(key);
      const user = input.users.find(({ id }) => id === grant.holderId);
      return [
        {
          grantId: grant.id,
          kind: "person",
          id: grant.holderId,
          name: user?.displayLabel,
          detail: user?.email,
          disabled: false
        }
      ];
    }
    if (grant.holderKind === "service_principal") {
      seen.add(key);
      const principal = input.principals.find(
        (candidate) => candidate.principal.id === grant.holderId
      )?.principal;
      return [
        {
          grantId: grant.id,
          kind: "service_principal",
          id: grant.holderId,
          name: principal?.displayLabel,
          detail: principal?.name,
          disabled: principal?.status === "disabled"
        }
      ];
    }
    return [];
  });
  const order = (holder: ResourceHolder) => (holder.kind === "person" ? 0 : 1);
  return holders.sort(
    (left, right) =>
      order(left) - order(right) || (left.name ?? left.id).localeCompare(right.name ?? right.id)
  );
}

/** The parameter in the address of Instance > API access that names the principal it opens on. */
const PRINCIPAL_PARAM = "principal";

/** The principal the address of the page names, read from its query. */
export function principalOfSearch(search: string): string | undefined {
  return new URLSearchParams(search).get(PRINCIPAL_PARAM) || undefined;
}

/** Where one service principal is read: `apiAccessPath`, open on that principal. */
export function principalHref(apiAccessPath: string, principalId: string): string {
  return `${apiAccessPath}?${new URLSearchParams({ [PRINCIPAL_PARAM]: principalId }).toString()}`;
}
