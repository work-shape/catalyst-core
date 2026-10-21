// @rights-screen: included in the rights wording guard.
import type { LocaleCode, PermissionGrantRow } from "@work-shape/catalyst-api-client";
import { GRANT_EFFECTS } from "@work-shape/catalyst-core";
import type { TranslationContextValue } from "../../shared/i18n";
import { wordsOfKind } from "./grant-words";
import { actionLabel, rightVerb, verbKeys, verbOnKind, type RightVerb } from "./right-words";

// The sentences of the rights screens: one per place and effect, as the Rights tab says a
// person's rows and a role's page says its grants (RIGHTS-DIALOG-1).

type Translate = TranslationContextValue["t"];

/** Where rows apply: one asset, one workspace or the whole instance. */
export type SentencePlace = Pick<PermissionGrantRow, "scopeKind" | "scopeId" | "scopeAsset">;

/** What a row allows or refuses there. */
export type SentenceGrant = Pick<PermissionGrantRow, "action" | "effect">;

/** The names the page was told, by id: of a workspace, and of an asset beyond agents and skills. */
export interface ScopeNames {
  workspace(workspaceId: string): string | undefined;
  asset(assetId: string): string | undefined;
}

/**
 * Where a row applies, in one line. An asset is named by the title its kind's list gives it,
 * else by its name; a workspace by the name the page was told. The server leaves an asset's
 * name out for a reader who may not see it, and the row then says that much, never an id.
 */
export function scopeLabel(grant: SentencePlace, t: Translate, names: ScopeNames): string {
  switch (grant.scopeKind) {
    case "instance":
      return t("access.scopeWholeInstance");
    case "workspace": {
      const name = grant.scopeId === undefined ? undefined : names.workspace(grant.scopeId);
      return name === undefined
        ? t("access.scopeWorkspaceHidden")
        : t("access.scopeWorkspace", { name });
    }
    case "asset": {
      const asset = grant.scopeAsset;
      const name =
        (grant.scopeId === undefined ? undefined : names.asset(grant.scopeId)) ?? asset?.name;
      if (asset === undefined || name === undefined) {
        return t("access.scopeAssetHidden");
      }
      const words = wordsOfKind(asset.kind);
      return words ? t(words.scopeAsset, { name }) : name;
    }
  }
}

/**
 * What one person's rows on one place say, one sentence per effect: "may view and edit agents
 * in Kai Spezis", "may not delete the agent tax-helper". A right that is no verb of the table,
 * such as adding rows to a Data Store, follows in its own words; where no sentence of its effect
 * names the place, it names the place itself.
 */
export function grantSentences(
  scope: SentencePlace,
  rows: readonly SentenceGrant[],
  t: Translate,
  locale: LocaleCode,
  names: ScopeNames
): { effect: SentenceGrant["effect"]; text: string }[] {
  return GRANT_EFFECTS.flatMap((effect) => {
    const grants = rows.filter((grant) => grant.effect === effect);
    const byKind = new Map<string, RightVerb[]>();
    const ownActions: string[] = [];
    for (const grant of grants) {
      const verb = rightVerb(grant.action);
      const kind = grant.action.slice(0, grant.action.indexOf("."));
      if (verb && wordsOfKind(kind)) {
        byKind.set(kind, [...(byKind.get(kind) ?? []), verb]);
      } else {
        ownActions.push(actionLabel(grant.action, t));
      }
    }
    const verbs = (list: readonly RightVerb[]) => {
      const joined = new Intl.ListFormat(locale, {
        type: effect === "deny" ? "disjunction" : "conjunction"
      }).format(list.map((verb) => t(verbKeys[verb])));
      return effect === "deny" ? t("access.rowNot", { verbs: joined }) : joined;
    };
    const kinds = [...byKind.entries()];
    const sentence =
      kinds.length === 0
        ? undefined
        : scope.scopeKind === "asset"
          ? t("access.rowOnAsset", {
              verbs: verbs(kinds.flatMap(([, list]) => list)),
              object: assetObject(scope, t, names)
            })
          : t("access.rowInPlace", {
              actions: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                kinds.map(([kind, list]) => verbOnKind(kind, verbs(list), t) ?? verbs(list))
              ),
              place: placePhrase(scope, t, names)
            });
    // A deny is marked by its badge, so its words do not say "Denied" again.
    const ownWords = ownActions.map((action) =>
      sentence === undefined
        ? t("access.rowOwnAt", { action, scope: scopeLabel(scope, t, names) })
        : t("access.rowAlso", { action })
    );
    return [
      ...(sentence === undefined ? [] : [{ effect, text: sentence }]),
      ...ownWords.map((text) => ({ effect, text }))
    ];
  });
}

/** Where a row on more than one asset applies, as the end of its sentence. */
function placePhrase(grant: SentencePlace, t: Translate, names: ScopeNames): string {
  switch (grant.scopeKind) {
    case "workspace": {
      const name = grant.scopeId === undefined ? undefined : names.workspace(grant.scopeId);
      return name === undefined ? t("access.placeWorkspaceHidden") : t("access.placeIn", { name });
    }
    case "instance":
      return t("access.placeInstance");
    default:
      // A retired place, named as the rows name it.
      return t("access.placeIn", { name: scopeLabel(grant, t, names) });
  }
}

/** The one asset a row applies to, as what its sentence allows or refuses. */
function assetObject(grant: SentencePlace, t: Translate, names: ScopeNames): string {
  const asset = grant.scopeAsset;
  const name =
    (grant.scopeId === undefined ? undefined : names.asset(grant.scopeId)) ?? asset?.name;
  const words = asset && wordsOfKind(asset.kind);
  return name === undefined || words === undefined
    ? t("access.objectHidden")
    : t(words.object, { name });
}
