import { useState } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import {
  furtherGrantKinds,
  grantsNameWorkspaces,
  loadFailure,
  type GrantKind
} from "../../access/access-model";
import type { GrantChoices } from "../../access/grants-tab";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@work-shape/catalyst-ui";
import { CheckTab, GrantsTab, NamespacesTab } from "../../access";
import {
  useAccessMutations,
  useEffectivePermissionsQuery,
  useNamespacesQuery,
  usePermissionGrantsQuery
} from "../../access/access-queries";
import { useQueries, useQuery } from "@tanstack/react-query";
import { listAll } from "@work-shape/catalyst-api-client";
import {
  useAdministeredCollaborationWorkspacesQuery,
  useConfigAssetsOverviewQuery,
  usePlatformContextQuery,
  useWorkspaceUsersQuery
} from "../../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../../shared/api/workspace-query-keys";
import { DocsReference } from "../../../shared/docs-links";
import { useTranslation } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";

/**
 * Instance > Access: the Namespaces of the instance, the grant rows on the assets of every kind
 * a right can be given on, and what one person may do with one asset. Each tab gets its data from here and shows it.
 */
export function AccessPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const api = { apiBaseUrl, authScope, client };
  const [checkedHolderId, setCheckedHolderId] = useState<string | undefined>();
  const [checkedKind, setCheckedKind] = useState("agent");
  const namespacesQuery = useNamespacesQuery(api);
  const grantsQuery = usePermissionGrantsQuery(api);
  const usersQuery = useWorkspaceUsersQuery({ ...api, enabled: true });
  // Tools, models and assets come with the agent configuration, which has its own right. A
  // reader without it still sees and revokes rows; the pickers say what could not be loaded.
  const overviewQuery = useConfigAssetsOverviewQuery({ ...api, enabled: true });
  const effectiveQuery = useEffectivePermissionsQuery({ ...api, holderId: checkedHolderId });
  // A grant names a kind beyond agents and skills while the instance has the kind: its module
  // is on. Which kinds a grant can name at all, core says.
  const contextQuery = usePlatformContextQuery({ ...api, enabled: true });
  const furtherKinds = furtherGrantKinds(contextQuery.data?.kinds.map((kind) => kind.kind));
  const kindAssetQueries = useQueries({
    queries: furtherKinds.map((kind) => ({
      queryKey: [...workspaceQueryKeys.assets(apiBaseUrl, authScope), "choice", kind],
      queryFn: () => listAll((paging) => client.assets.list({ params: { kind }, query: paging })),
      retry: false
    }))
  });
  const kindAssets: Partial<Record<GrantKind, GrantChoices>> = Object.fromEntries(
    furtherKinds.map((kind, index) => {
      const query = kindAssetQueries[index];
      return [
        kind,
        {
          items: query?.data?.map((asset) => ({
            id: asset.id,
            // The display name, with the id the rows list it by and what it says of itself.
            name: asset.title,
            description: asset.description ? `${asset.name} · ${asset.description}` : asset.name
          })),
          failed: Boolean(query?.error)
        }
      ];
    })
  );
  const namesWorkspaces = grantsNameWorkspaces(furtherKinds, grantsQuery.data ?? []);
  // The Check tab asks about every kind the instance has. Agents and skills come with the
  // agent configuration; the assets of any other kind are listed once the kind is chosen.
  const checkedOtherKind =
    checkedKind !== "agent" &&
    checkedKind !== "skill" &&
    Boolean(contextQuery.data?.kinds.some((kind) => kind.kind === checkedKind));
  const checkedKindAssetsQuery = useQuery({
    queryKey: [...workspaceQueryKeys.assets(apiBaseUrl, authScope), "choice", checkedKind],
    queryFn: () =>
      listAll((paging) => client.assets.list({ params: { kind: checkedKind }, query: paging })),
    enabled: checkedOtherKind,
    retry: false
  });
  const workspacesQuery = useAdministeredCollaborationWorkspacesQuery({
    ...api,
    enabled: namesWorkspaces
  });
  const mutations = useAccessMutations(api);
  const overview = overviewQuery.data;
  const overviewFailure = loadFailure(overviewQuery.error);
  const retry = (query: { refetch(): Promise<unknown> }) => () => {
    query.refetch().catch(() => undefined);
  };

  return (
    <>
      <PageHeader
        title={t("settings.access")}
        description={
          <>
            {t("access.description")} <DocsReference to="accessPage" />
          </>
        }
      />
      <Tabs defaultValue="namespaces">
        <TabsList label={t("access.tabs")}>
          <TabsTrigger value="namespaces" count={namespacesQuery.data?.length}>
            {t("access.tabNamespaces")}
          </TabsTrigger>
          <TabsTrigger value="grants" count={grantsQuery.data?.length}>
            {t("access.tabGrants")}
          </TabsTrigger>
          <TabsTrigger value="check">{t("access.tabCheck")}</TabsTrigger>
        </TabsList>
        <TabsContent value="namespaces" className="pt-5">
          <NamespacesTab
            namespaces={namespacesQuery.data}
            loadFailed={Boolean(namespacesQuery.error)}
            onRetry={retry(namespacesQuery)}
            references={
              overview && {
                toolNames: overview.references.enabledToolNames,
                modelBindings: overview.references.modelBindings,
                assets: overview.assets
              }
            }
            referencesFailure={overviewFailure}
            onCreate={(request) => mutations.createNamespace.mutateAsync(request)}
            onUpdate={(prefix, body) => mutations.updateNamespace.mutateAsync({ prefix, body })}
            onDelete={(prefix) => mutations.deleteNamespace.mutateAsync(prefix)}
          />
        </TabsContent>
        <TabsContent value="grants" className="pt-5">
          <GrantsTab
            grants={grantsQuery.data}
            loadFailed={Boolean(grantsQuery.error)}
            onRetry={retry(grantsQuery)}
            users={usersQuery.data}
            usersFailed={Boolean(usersQuery.error)}
            assets={overview?.assets}
            assetsFailure={overviewFailure}
            kindAssets={kindAssets}
            workspaces={
              namesWorkspaces
                ? {
                    items: workspacesQuery.data?.map((workspace) => ({
                      id: workspace.id,
                      name: workspace.name
                    })),
                    failed: Boolean(workspacesQuery.error)
                  }
                : undefined
            }
            onGrant={(requests) => mutations.grant.mutateAsync(requests)}
            onRevoke={(grantId) => mutations.revoke.mutateAsync(grantId)}
          />
        </TabsContent>
        <TabsContent value="check" className="pt-5">
          <CheckTab
            kinds={contextQuery.data?.kinds}
            kindAssets={
              checkedOtherKind
                ? {
                    items: checkedKindAssetsQuery.data?.map((asset) => ({
                      id: asset.id,
                      kind: checkedKind,
                      name: asset.name
                    })),
                    failure: loadFailure(checkedKindAssetsQuery.error),
                    retry: retry(checkedKindAssetsQuery)
                  }
                : undefined
            }
            onKindChange={setCheckedKind}
            users={usersQuery.data}
            usersFailed={Boolean(usersQuery.error)}
            assets={overview?.assets}
            assetsFailure={overviewFailure}
            onRetryAssets={retry(overviewQuery)}
            namespaces={namespacesQuery.data}
            modelBindings={overview?.references.modelBindings}
            holderId={checkedHolderId}
            onHolderChange={setCheckedHolderId}
            effective={effectiveQuery.data}
            effectiveFailure={
              effectiveQuery.error === null
                ? undefined
                : effectiveQuery.error instanceof ApiError && effectiveQuery.error.status === 404
                  ? "hidden"
                  : "failed"
            }
            onRetry={retry(effectiveQuery)}
            holderGrants={grantsQuery.data?.filter(
              (grant) => grant.holderKind === "user" && grant.holderId === checkedHolderId
            )}
            grantsFailed={Boolean(grantsQuery.error)}
            onRetryGrants={retry(grantsQuery)}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
