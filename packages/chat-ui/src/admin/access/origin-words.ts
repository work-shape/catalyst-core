import type { AccessOrigin, HolderRights } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import { roleLabel } from "../control-plane/user-administration-model";
import { wordsOfKind } from "./grant-words";

// Where a right comes from, in the words of the rights screens: the role by its name, a right
// given directly, a membership, and the deny that refuses it. The server decided all of it;
// these only name what it said.

type Translate = TranslationContextValue["t"];

/** A place a right or an origin names, as the server named it for the reader. */
type NamedPlace = Pick<AccessOrigin, "scopeKind" | "scopeId" | "scopeAsset" | "scopeWorkspace">;

/** The name of a role an origin names: a built-in role in the interface's words. */
export function originRoleName(
  roleId: string | undefined,
  roles: HolderRights["roles"],
  t: Translate
): string | undefined {
  if (roleId === undefined) return undefined;
  const role = roles.find((candidate) => candidate.id === roleId);
  const builtIn = role === undefined || role.builtIn ? roleLabel(roleId) : undefined;
  return builtIn === undefined ? (role?.name ?? roleId) : t(builtIn);
}

/** Where a right or an origin applies, in a few words. Never an id. An asset by its title. */
export function placeLabel(place: NamedPlace, t: Translate): string {
  switch (place.scopeKind) {
    case "instance":
      return t("access.scopeWholeInstance");
    case "workspace": {
      const workspace = place.scopeWorkspace;
      if (workspace?.personal) return t("access.scopePersonalWorkspace");
      return workspace?.name === undefined
        ? t("access.scopeWorkspaceHidden")
        : t("access.scopeWorkspace", { name: workspace.name });
    }
    case "asset": {
      const asset = place.scopeAsset;
      if (asset?.active === false) return t("access.scopeAssetGone");
      const words = asset && wordsOfKind(asset.kind);
      // The title people read, with the asset's name where it has none.
      const name = asset?.title ?? asset?.name;
      return name === undefined || words === undefined
        ? t("access.scopeAssetHidden")
        : t(words.scopeAsset, { name });
    }
  }
}

/** Where one entry comes from: "Rolle Buchhaltung", "Direkt vergeben", "Direkt verweigert". */
export function originLabel(
  origin: AccessOrigin,
  roles: HolderRights["roles"],
  t: Translate
): string {
  const deny = origin.effect === "deny";
  if (origin.source === "role") {
    const role = originRoleName(origin.roleId, roles, t) ?? t("access.originAnyRole");
    return t(deny ? "access.originRoleDeny" : "access.originRole", { role });
  }
  if (origin.source === "membership") return t("access.originMembership");
  return t(deny ? "access.originGrantDeny" : "access.originGrant");
}

type NamedWorkspace = NonNullable<AccessOrigin["scopeWorkspace"]>;

/** The workspaces a right holds in only, as one line; nothing where it holds everywhere. */
export function onlyInLabel(
  workspaces: readonly NamedWorkspace[] | undefined,
  t: Translate,
  locale: string
): string | undefined {
  if (workspaces === undefined) return undefined;
  const places = workspaces.map((workspace) =>
    placeLabel({ scopeKind: "workspace", scopeWorkspace: workspace }, t)
  );
  return t("access.onlyInWorkspaces", {
    places: new Intl.ListFormat(locale, { type: "disjunction" }).format(places)
  });
}

/** The App's audience where it, and not an entry, decided: "Verfügbar für alle". */
export function availabilityLabel(
  availability: string | undefined,
  allowed: boolean,
  t: Translate
): string | undefined {
  if (availability === "instance") return t("access.availabilityInstance");
  if (availability === "self") {
    return t(allowed ? "access.availabilitySelfAllowed" : "access.availabilitySelfRefused");
  }
  return undefined;
}
