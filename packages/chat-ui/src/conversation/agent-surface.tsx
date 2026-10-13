import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { IconButton, Skeleton } from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useAppsHost } from "../apps/apps-host";
import { AgentEditor, type SkillChoice } from "../build-area/agent-editor";
import { agentConfigToForm, type AgentFormState } from "../build-area/asset-form-model";
import type { BuildPageSlot } from "../build-area/build-asset-kind";
import type { BuildWriteOutcome } from "../build-area/build-refusals";
import { AGENT_ASSET_KIND } from "../build-area/build-rights";
import { AGENTS_BUILD_PATH } from "../build-area/build-route";
import { useTranslation } from "../i18n";
import { retryUnlessGone } from "../pages/page-address";

/**
 * The saved state of an agent, under the key of every asset read: each save of the agent of
 * the conversation drops it, and the surface shows the agent as it is now.
 */
export function useAgentAsset(agent: string, enabled = true) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: [...workspaceQueryKeys.assets(apiBaseUrl, "standalone"), AGENT_ASSET_KIND, agent],
    queryFn: ({ signal }) =>
      client.assets.get({ params: { kind: AGENT_ASSET_KIND, name: agent }, signal }),
    enabled,
    retry: retryUnlessGone,
    refetchOnMount: "always"
  });
}

/** The name people read for an agent, in the reader's language, or its id. */
export function agentTitle(form: AgentFormState, locale: string, fallback: string): string {
  const pair = form.displayName;
  const title = (locale === "de" ? pair.de : pair.en) || pair.en || pair.de;
  return title.trim() === "" ? fallback : title;
}

/** The form of an agent shown read-only: nothing on the surface saves. */
const SURFACE_PAGE: BuildPageSlot = { ref: null, above: null, shown: () => undefined };
const NO_SKILL_CHOICE: SkillChoice = { options: [], onSearch: () => undefined };
const ignoreUnsaved = () => undefined;
const refuseSave = (): Promise<BuildWriteOutcome> =>
  Promise.resolve({ ok: false, conflict: false, refusals: [] });

/**
 * An agent beside the conversation in which its agent changes it: the form of its page in
 * Build, read only. An agent has no draft: what is saved is live at once, so the surface shows
 * the saved state and is drawn again with each save, and Build is where a person changes it by
 * hand.
 */
export function AgentSurface({ agent }: { agent: string }) {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const query = useAgentAsset(agent);
  // The model names the form shows. A reader the instance does not tell sees the ids.
  const references = useQuery({
    queryKey: workspaceQueryKeys.platformReferences(apiBaseUrl, "standalone"),
    queryFn: ({ signal }) => client.platform.references.get({ signal }),
    retry: false
  });
  if (query.isPending) {
    return (
      <div className="grid gap-3 p-(--layout-gutter)">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <p className="p-(--layout-gutter) text-body text-muted-foreground">
        {t("agentSurfaceMissing")}
      </p>
    );
  }
  const asset = query.data;
  return (
    <div data-testid="agent-surface" className="min-w-0">
      <AgentEditor
        // The form keeps what it was first given: each saved revision draws it anew.
        key={asset.revision}
        frame={{
          page: SURFACE_PAGE,
          asset,
          start: undefined,
          canWrite: false,
          readOnlyReason: t("agentSurfaceReadOnly", { number: asset.revision }),
          instanceWrite: false,
          back: null,
          actions: null,
          notice: null,
          onUnsavedChange: ignoreUnsaved,
          save: refuseSave
        }}
        initialForm={agentConfigToForm(asset.config)}
        isDefault={asset.isDefault === true}
        references={references.data}
        editableAgentFields={[]}
        canManageAgentModels={false}
        skillChoice={NO_SKILL_CHOICE}
      />
    </div>
  );
}

/** Opens the agent in Build from the head of its surface. */
export function AgentSurfaceActions({ agent }: { agent: string }) {
  const { t } = useTranslation();
  const host = useAppsHost();
  if (host === undefined) {
    return null;
  }
  return (
    <IconButton
      label={t("agentSurfaceOpenBuild")}
      onClick={() =>
        host.showRoute({ kind: "build-asset", assetKind: AGENTS_BUILD_PATH, name: agent })
      }
    >
      <ExternalLink aria-hidden="true" />
    </IconButton>
  );
}
