import type { EffectivePermissions } from "@work-shape/catalyst-api-client";
import {
  authorizeHeldRights,
  explainAccessEntries,
  isGrantableAt,
  transferableAccessEntries,
  type AccessResource,
  type DeniedAssets
} from "@work-shape/catalyst-core";
import {
  GRANT_KINDS,
  GRANT_SCOPE_KINDS,
  grantAction,
  grantVerbs,
  type GrantKind,
  type GrantScopeKind,
  type GrantVerb
} from "./access-model";

/** One existing place a right may name, with the resource the resolver checks. */
export interface GrantChoice {
  id: string;
  name: string;
  description?: string;
  resource?: AccessResource;
}

export interface GrantChoices {
  items: readonly GrantChoice[] | undefined;
  failed: boolean;
}

/**
 * Choices from the giver's loaded effective rights, using the same resolver and lending rule
 * as the server. Missing rights or resource metadata never widen a choice. The server checks
 * again, including the Workflow principal for run data, when the person submits.
 */
export function grantOptions(
  giver: EffectivePermissions | undefined,
  assets: Partial<Record<GrantKind, GrantChoices>>,
  workspaces: GrantChoices | undefined
) {
  const entries = giver?.holderActive ? giver.items : [];
  const transferable = transferableAccessEntries(entries);
  const access = {
    authorize: (action: string, resource?: AccessResource) =>
      explainAccessEntries(entries, action, resource).decision,
    authorizeTransfer: (action: string, resource?: AccessResource) =>
      explainAccessEntries(transferable, action, resource).decision,
    denials: (action: string) =>
      entries.filter((entry) => entry.action === action && entry.effect === "deny")
  };
  const deniedAssets: DeniedAssets = new Map(
    Object.values(assets).flatMap((choices) =>
      (choices?.items ?? []).flatMap(({ id, resource }) =>
        resource?.kind !== undefined && resource.name !== undefined
          ? [
              [
                id,
                {
                  kind: resource.kind,
                  name: resource.name,
                  ...(resource.workspaceId === undefined
                    ? {}
                    : { workspaceId: resource.workspaceId })
                }
              ] as const
            ]
          : []
      )
    )
  );
  const holds = (action: string, resource?: AccessResource) => {
    // A hidden asset's owner and name are unknown. Do not overlook a workspace deny
    // just because the loaded row cannot place it; the person can still revoke that row.
    if (
      resource?.assetId !== undefined &&
      resource.kind === undefined &&
      access
        .denials(action)
        .some((deny) => deny.scopeKind !== "instance" && deny.scopeKind !== "asset")
    )
      return false;
    return authorizeHeldRights(
      access,
      [{ action, ...(resource === undefined ? {} : { resource }) }],
      { gives: { label: "" } },
      deniedAssets
    ).allowed;
  };
  const assetResource = (choice: GrantChoice): AccessResource =>
    choice.resource ?? { assetId: choice.id };
  const choicesAt = (kind: GrantKind, scope: GrantScopeKind): readonly GrantChoice[] =>
    scope === "workspace" ? (workspaces?.items ?? []) : (assets[kind]?.items ?? []);
  const resourceAt = (scope: GrantScopeKind, choice: GrantChoice) =>
    scope === "workspace" ? { workspaceId: choice.id } : assetResource(choice);
  const heldVerbs = (kind: GrantKind, scope: GrantScopeKind, resource?: AccessResource) =>
    grantVerbs(kind).filter((verb) => {
      const action = grantAction(kind, verb);
      return action !== undefined && isGrantableAt(action, scope) && holds(action, resource);
    });
  const satisfies = (
    kind: GrantKind,
    scope: GrantScopeKind,
    verbs: readonly GrantVerb[],
    resource?: AccessResource
  ) => {
    const held = heldVerbs(kind, scope, resource);
    return verbs.length === 0 ? held.length > 0 : verbs.every((verb) => held.includes(verb));
  };
  const places = (kind: GrantKind, verbs: readonly GrantVerb[]) =>
    GRANT_SCOPE_KINDS.filter((scope) =>
      scope === "instance"
        ? satisfies(kind, scope, verbs)
        : choicesAt(kind, scope).some((choice) =>
            satisfies(kind, scope, verbs, resourceAt(scope, choice))
          )
    );
  return {
    kinds: GRANT_KINDS.filter((kind) => assets[kind] !== undefined && places(kind, []).length > 0),
    places,
    choices: (kind: GrantKind, scope: GrantScopeKind, verbs: readonly GrantVerb[]) =>
      choicesAt(kind, scope).filter((choice) =>
        satisfies(kind, scope, verbs, resourceAt(scope, choice))
      ),
    verbs: (kind: GrantKind, scope: GrantScopeKind | undefined, choiceId?: string) => {
      if (scope === undefined) return [];
      if (scope === "instance") return heldVerbs(kind, scope);
      const choices = choicesAt(kind, scope).filter(
        (choice) => choiceId === undefined || choice.id === choiceId
      );
      return grantVerbs(kind).filter((verb) =>
        choices.some((choice) => heldVerbs(kind, scope, resourceAt(scope, choice)).includes(verb))
      );
    }
  };
}
