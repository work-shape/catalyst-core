import { createContext, useContext, type ReactNode } from "react";
import { Users } from "lucide-react";
import { Chip, ScopeChip, type ChipSize } from "@work-shape/catalyst-ui";
import type { BuildWorkspace } from "../../shared/build-rights";
import type { BuildAsset } from "./build-kind/asset";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { RefusalPlace } from "../../shared/i18n/refusals";

// SCOPE-WORDS: one ladder of words for where an asset sits, the same on every screen of Studio.
// "Nur ich" is the reader's Personal Workspace, a Shared Workspace goes by its name, and "Alle"
// is the instance. The place also says who uses an asset, unless the asset says otherwise.
// Members never read "Instanz" or "Scope" for it ("Wo, never Scope").

type Translate = TranslationContextValue["t"];

/** Where an asset sits, as its record names it. */
export type AssetOwner = { kind: "instance" } | { kind: "workspace"; workspaceId: string };

/** One rung of the ladder and the word it is shown with. */
export interface AssetPlace {
  rung: "mine" | "workspace" | "all";
  name: string;
}

/** The workspaces the reader knows by name, as Studio reads them. */
type KnownWorkspaces = readonly BuildWorkspace[];

const AssetPlacesContext = createContext<KnownWorkspaces>([]);

/** Hands the pages of Studio the workspaces they name a place by. */
export const AssetPlacesProvider = AssetPlacesContext.Provider;

/** The place of an owner, in the ladder's words. A workspace the reader is not shown has none. */
export function assetPlace(
  owner: AssetOwner,
  workspaces: KnownWorkspaces,
  t: Translate
): AssetPlace {
  if (owner.kind === "instance") return { rung: "all", name: t("build.placeAll") };
  const workspace = workspaces.find((candidate) => candidate.id === owner.workspaceId);
  if (workspace?.personal) return { rung: "mine", name: t("build.placeMine") };
  return { rung: "workspace", name: workspace?.name ?? t("build.placeOtherWorkspace") };
}

/** The workspaces Studio names places by, for a page that names one itself. */
export function useKnownWorkspaces(): KnownWorkspaces {
  return useContext(AssetPlacesContext);
}

/**
 * Where a refusal is told, as far as it names a place: the reader's own, or a workspace by the
 * name Studio shows. A workspace the reader is not shown is named by no one.
 */
export function refusalPlaceOf(workspaces: KnownWorkspaces): RefusalPlace {
  return {
    placeOf: (workspaceId) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace === undefined) return undefined;
      return workspace.personal ? { mine: true } : { name: workspace.name };
    }
  };
}

const SCOPE_OF_RUNG = { mine: "personal", workspace: "workspace", all: "instance" } as const;

/**
 * Who uses an agent, where its record says so and it is not everyone of its place: the
 * workspaces it is offered in, nobody yet, or only the people with the right to use it.
 */
export function agentAudience(
  agent: Pick<BuildAsset, "scope" | "availability" | "agentUse">,
  workspaces: KnownWorkspaces,
  t: Translate,
  locale: string
): string | undefined {
  if (agent.agentUse === "granted") return t("build.usedWithRight");
  const offered = agent.availability;
  // An agent of a workspace is used there; one the instance offers everywhere, by everyone.
  if (agent.scope.kind !== "instance" || !offered || offered.mode === "all") return undefined;
  const names = offered.collaborationWorkspaceIds.map(
    (id) => assetPlace({ kind: "workspace", workspaceId: id }, workspaces, t).name
  );
  if (offered.personalWorkspaces) names.push(t("build.usedByEachOwn"));
  if (names.length === 0) return t("build.usedNowhere");
  return t("build.usedIn", {
    names: new Intl.ListFormat(locale, { type: "conjunction" }).format(names)
  });
}

/**
 * Where an asset sits and, where it differs, who uses it: one line of chips for a list row or a
 * page head.
 */
export function AssetPlaceLine({
  owner,
  audience,
  size = "sm"
}: {
  owner: AssetOwner;
  /** Who uses the asset, where that is not everyone of its place. */
  audience?: string;
  size?: ChipSize;
}) {
  const { t } = useTranslation();
  const place = assetPlace(owner, useKnownWorkspaces(), t);
  return (
    <>
      <ScopeChip size={size} scope={SCOPE_OF_RUNG[place.rung]} name={place.name} />
      {audience === undefined ? null : (
        <Chip size={size} leading={<Users aria-hidden="true" />}>
          {audience}
        </Chip>
      )}
    </>
  );
}

/**
 * The place line as the first row of an asset page's content. It stands there, not in the
 * head, because the head's chips give way to the name and the actions: on a phone, and beside
 * an agent's actions, the place would not be shown at all.
 */
export function AssetPlaceRow({ children }: { children: ReactNode }) {
  return (
    <div data-asset-place="" className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
      {children}
    </div>
  );
}
