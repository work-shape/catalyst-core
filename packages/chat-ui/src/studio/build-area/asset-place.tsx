import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { Users } from "lucide-react";
import { Chip, ScopeChip, type ChipSize } from "@work-shape/catalyst-ui";
import type { BuildWorkspace } from "../../shared/build-rights";
import type { BuildAsset } from "./build-kind/asset";
import type { AgentAvailabilityForm } from "./asset-form-model";
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

/** Who uses an agent, in a sentence, and whether that is nobody yet. */
export interface AgentAudience {
  text: string;
  /** No chat can choose it: the page points a reader who may change that to "Available in". */
  nowhere?: true;
}

/**
 * Who uses an agent, where its record says so: for an agent of everyone, the workspaces where a
 * chat can choose it in the words of its "Available in" section, or that no chat can yet; only
 * the people with the right to use it. An agent of a workspace is used there: its place says so.
 */
export function agentAudience(
  agent: Pick<BuildAsset, "scope" | "availability" | "agentUse">,
  workspaces: KnownWorkspaces,
  t: Translate,
  locale: string
): AgentAudience | undefined {
  if (agent.agentUse === "granted") return { text: t("build.usedWithRight") };
  const offered = agent.availability;
  if (agent.scope.kind !== "instance" || !offered) return undefined;
  const names = offeredPlaces(offered, workspaces, t, locale);
  if (names === undefined) return { text: t("build.usedNowhere"), nowhere: true };
  return { text: t("build.usedIn", { names }) };
}

/**
 * Where a chat can choose an asset, in the words of its "Available in" section: "All
 * workspaces", or the workspaces by their names. Nothing where no chat can.
 */
export function offeredPlaces(
  offered: Pick<AgentAvailabilityForm, "mode" | "personalWorkspaces" | "collaborationWorkspaceIds">,
  workspaces: KnownWorkspaces,
  t: Translate,
  locale: string
): string | undefined {
  if (offered.mode === "all") return t("configAvailabilityAll");
  const names = offered.collaborationWorkspaceIds.map(
    (id) => assetPlace({ kind: "workspace", workspaceId: id }, workspaces, t).name
  );
  if (offered.personalWorkspaces) names.push(t("configAvailabilityPersonal"));
  if (names.length === 0) return undefined;
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
}

/** The id of an agent page's "Available in" section, which the audience chip leads to. */
export const AVAILABILITY_SECTION_ID = "availability";

/**
 * Where an asset sits and, where it differs, who uses it: one line of chips for a list row or a
 * page head.
 */
export function AssetPlaceLine({
  owner,
  audience,
  audienceTo,
  size = "sm"
}: {
  owner: AssetOwner;
  /** Who uses the asset, where its record says. */
  audience?: string;
  /** The section of the page that changes who uses it: the audience chip leads there. */
  audienceTo?: string;
  size?: ChipSize;
}) {
  const { t } = useTranslation();
  const place = assetPlace(owner, useKnownWorkspaces(), t);
  return (
    <>
      <ScopeChip size={size} scope={SCOPE_OF_RUNG[place.rung]} name={place.name} />
      {audience === undefined ? null : (
        <Chip
          size={size}
          leading={<Users aria-hidden="true" />}
          {...(audienceTo === undefined
            ? {}
            : {
                href: `#${audienceTo}`,
                onClick: (event: MouseEvent<HTMLElement>) => {
                  event.preventDefault();
                  document
                    .getElementById(audienceTo)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              })}
        >
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
