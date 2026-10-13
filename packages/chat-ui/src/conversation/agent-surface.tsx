import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Chip, IconButton, KeyValue, KeyValueList, Skeleton } from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useAppsHost } from "../apps/apps-host";
import { agentConfigToForm, type AgentFormState } from "../build-area/asset-form-model";
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

function Names({ names, empty }: { names: readonly string[]; empty: string }) {
  if (names.length === 0) {
    return <span className="text-muted-foreground">{empty}</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <Chip key={name} size="sm">
          {name}
        </Chip>
      ))}
    </span>
  );
}

/**
 * An agent beside the conversation in which its agent changes it, read only. An agent has no
 * draft: what is saved is live at once, so the surface shows the saved state, and Build is
 * where a person changes it by hand.
 */
export function AgentSurface({ agent }: { agent: string }) {
  const { locale, t } = useTranslation();
  const query = useAgentAsset(agent);
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
  const form = agentConfigToForm(query.data.config);
  const description = locale === "de" ? form.description.de : form.description.en;
  return (
    <div className="grid gap-4 p-(--layout-gutter)" data-testid="agent-surface">
      <p className="text-caption text-muted-foreground">
        {t("agentSurfaceRevision", { number: query.data.revision })}
      </p>
      <KeyValueList layout="stacked">
        <KeyValue label={t("agentSurfaceName")}>{agentTitle(form, locale, agent)}</KeyValue>
        {description.trim() === "" ? null : (
          <KeyValue label={t("agentSurfaceDescription")}>{description}</KeyValue>
        )}
        <KeyValue label={t("agentSurfaceModel")}>
          {form.modelBindingId === "" ? t("agentSurfaceDefaultModel") : form.modelBindingId}
        </KeyValue>
        <KeyValue label={t("agentSurfaceTools")}>
          <Names names={form.toolNames} empty={t("agentSurfaceNone")} />
        </KeyValue>
        <KeyValue label={t("agentSurfaceSkills")}>
          <Names names={form.skillNames} empty={t("agentSurfaceNone")} />
        </KeyValue>
        <KeyValue label={t("agentSurfaceInstructions")} foldable>
          <span className="whitespace-pre-wrap">
            {form.instructions.trim() === "" ? t("agentSurfaceNone") : form.instructions}
          </span>
        </KeyValue>
      </KeyValueList>
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
