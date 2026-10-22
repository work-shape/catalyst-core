import { useQuery } from "@tanstack/react-query";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-client";
import {
  DATA_STORE_ASSET_KIND,
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ASSET_KIND
} from "@work-shape/catalyst-core";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useApp } from "../../studio/apps/app-data";
import { appTitle } from "../../studio/apps/app-model";
import { agentConfigToForm, type AgentFormState } from "../../studio/build-area/asset-form-model";
import { assetConfigTitle } from "../../studio/build-area/build-model";
import { AGENT_ASSET_KIND } from "../../shared/build-rights";
import { useTranslation } from "../../shared/i18n";
import { retryUnlessGone } from "../../studio/pages/page-address";
import { useWorkflowNames } from "../../studio/workflows/workflow-data";
import type { SubjectAsset } from "./subject-run";

/** The kinds whose title is read from their saved definition. */
const DEFINITION_TITLED: ReadonlySet<string> = new Set([
  AGENT_ASSET_KIND,
  DATA_STORE_ASSET_KIND,
  KNOWLEDGE_BASE_ASSET_KIND,
  "skill"
]);

/**
 * The saved state of an agent, a Data Store, a Knowledge Base or a skill, under the key of every asset
 * read: each save of the asset of the conversation drops it, and what shows the asset shows it
 * as it is now. The asset is the instance's or, where its first save made it, the conversation
 * workspace's (WS-OWN-1a): the workspace's list says which, and the read asks there.
 */
function useSubjectAsset(
  kind: string,
  name: string,
  workspaceId: string | undefined,
  enabled: boolean
) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: [
      ...workspaceQueryKeys.assets(apiBaseUrl, "standalone"),
      kind,
      name,
      workspaceId ?? ""
    ],
    queryFn: async ({ signal }) => {
      const params = { kind, name };
      if (workspaceId === undefined) {
        return client.assets.get({ params, signal });
      }
      const here = await client.assets.list({
        params: { kind },
        query: { workspaceId, prefix: name, limit: 50 },
        signal
      });
      const owned = here.items.some(
        (item) => item.name === name && item.scope.kind === "workspace"
      );
      return client.assets.get({ params, ...(owned ? { query: { workspaceId } } : {}), signal });
    },
    enabled,
    retry: retryUnlessGone,
    refetchOnMount: "always"
  });
}

/** The name people read for an agent, in the reader's language, or its id. */
function agentTitle(form: AgentFormState, locale: string, fallback: string): string {
  const pair = form.displayName;
  const title = (locale === "de" ? pair.de : pair.en) || pair.en || pair.de;
  return title.trim() === "" ? fallback : title;
}

/** The name people read for the asset a conversation is about, once its record arrived. */
export function useSubjectTitle(
  subject: SubjectAsset | undefined,
  workspaceId: string | undefined
): string {
  const { locale } = useTranslation();
  const kind = subject?.kind;
  const name = subject?.name ?? "";
  const [workflowTitle] = useWorkflowNames(
    kind === WORKFLOW_ASSET_KIND ? workspaceId : undefined,
    kind === WORKFLOW_ASSET_KIND ? [name] : []
  );
  const app = useApp(workspaceId ?? "", name, kind === APP_ASSET_KIND && workspaceId !== undefined);
  const asset = useSubjectAsset(
    kind ?? "",
    name,
    workspaceId,
    kind !== undefined && DEFINITION_TITLED.has(kind)
  );
  if (kind === WORKFLOW_ASSET_KIND) {
    return workflowTitle ?? name;
  }
  if (kind === APP_ASSET_KIND) {
    return appTitle(app.app, name);
  }
  if (kind === AGENT_ASSET_KIND && asset.data) {
    return agentTitle(agentConfigToForm(asset.data.config), locale, name);
  }
  // A store's or a skill's title, or its name until its definition arrived or where it is not
  // read.
  if (kind !== undefined && DEFINITION_TITLED.has(kind) && asset.data) {
    return assetConfigTitle(asset.data, locale);
  }
  return name;
}
