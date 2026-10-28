import { useQueries } from "@tanstack/react-query";
import { ownerReachRefusal, type AssetOwnerReach } from "@work-shape/catalyst-core";
import type { BuildWorkspace } from "../../shared/build-rights";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useKnownWorkspaces, type AssetOwner, type AssetPlace } from "./asset-place";
import { shareTargets, type AssetShareTarget } from "./asset-share-model";
import type { ListedAsset } from "./owned-choices";

// SCOPE-WORDS: an agent's chooser shows what the reader sees in their other places, which the
// agent cannot name, greyed with the reason instead of hidden. The one owner check decides
// what the agent cannot name; this reads the assets the reader may list there, by name and
// title only, and says why and where they could be shared to.

type Translate = TranslationContextValue["t"];

/** An asset of another place of the reader's, which an asset of the chooser's owner cannot name. */
export interface UnreachableAsset {
  asset: ListedAsset;
  owner: AssetOwner & { kind: "workspace" };
}

/** The owner as the one owner check reads it. */
function reachOf(owner: AssetOwner, workspaces: readonly BuildWorkspace[]): AssetOwnerReach {
  if (owner.kind === "instance") return owner;
  const workspace = workspaces.find((candidate) => candidate.id === owner.workspaceId);
  return {
    kind: "workspace",
    workspaceId: owner.workspaceId,
    workspaceKind: workspace === undefined ? undefined : workspace.personal ? "personal" : "shared"
  };
}

/**
 * The reader's places whose assets an asset of `owner` cannot name: their own and each team they
 * are a member of, as far as the one owner check refuses a reference there.
 */
export function unreachablePlaces(
  owner: AssetOwner,
  workspaces: readonly BuildWorkspace[]
): BuildWorkspace[] {
  const source = reachOf(owner, workspaces);
  return workspaces.filter(
    (workspace) =>
      (workspace.member || workspace.personal === true) &&
      ownerReachRefusal(source, {
        kind: "reference",
        target: reachOf({ kind: "workspace", workspaceId: workspace.id }, workspaces)
      }) !== undefined
  );
}

/**
 * A hook: the assets of a kind in the reader's other places that an asset of `owner` cannot
 * name, the first page of each that matches the search. Nothing while `enabled` is false.
 */
export function useUnreachableChoices({
  kind,
  owner,
  search,
  limit,
  enabled
}: {
  kind: string;
  /** The workspace of the asset that chooses; left out for one of everyone. */
  owner: string | undefined;
  search: string;
  limit: number;
  enabled: boolean;
}): UnreachableAsset[] {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const places = unreachablePlaces(
    owner === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId: owner },
    useKnownWorkspaces()
  );
  const reads = useQueries({
    queries: places.map((workspace) => ({
      queryKey: [
        ...workspaceQueryKeys.assets(apiBaseUrl, authScope),
        "choice",
        kind,
        "elsewhere",
        workspace.id,
        search
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        client.assets.list({
          params: { kind },
          query: { limit, workspaceId: workspace.id, ...(search ? { text: search } : {}) },
          signal
        }),
      enabled,
      retry: false
    }))
  });
  if (!enabled) return [];
  return places.flatMap((workspace, index) =>
    (reads[index]?.data?.items ?? []).map((asset) => ({
      asset,
      owner: { kind: "workspace" as const, workspaceId: workspace.id }
    }))
  );
}

/** The words of a reason, per kind: the noun's pronoun differs in German. */
export interface UnreachableWords {
  cannotAll: TranslationKey;
  cannotMine: TranslationKey;
  cannotIn: TranslationKey;
}

/**
 * Why an agent cannot use an asset the reader sees: where the asset sits, then that an agent of
 * the agent's place cannot use it.
 */
export function unreachableReason(
  asset: AssetPlace,
  agent: AssetPlace,
  t: Translate,
  words: UnreachableWords
): string {
  const where =
    asset.rung === "mine"
      ? t("build.reachOnlyMine")
      : t("build.reachInWorkspace", { workspace: asset.name });
  const cannot =
    agent.rung === "all"
      ? t(words.cannotAll)
      : agent.rung === "mine"
        ? t(words.cannotMine)
        : t(words.cannotIn, { workspace: agent.name });
  return `${where} ${cannot}`;
}

/**
 * Where a greyed asset could be shared to so the agent can use it: the agent's own place, where
 * the ladder goes up there from the asset's (SHARE-1). Never down or sideways.
 */
export function shareUpTo(
  asset: AssetOwner,
  agent: AssetOwner,
  workspaces: readonly BuildWorkspace[],
  t: Translate
): { to: AssetShareTarget; label: string } | undefined {
  const to = shareTargets(asset, workspaces).find((target) =>
    target.kind === "instance"
      ? agent.kind === "instance"
      : agent.kind === "workspace" && target.workspaceId === agent.workspaceId
  );
  if (to === undefined) return undefined;
  return {
    to,
    label: to.kind === "instance" ? t("share.withEveryone") : t("share.withTeam", { team: to.name })
  };
}
