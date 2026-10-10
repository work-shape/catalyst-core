import { useState } from "react";
import { ApiError } from "@vivd-catalyst/api-client";
import { loadFailure } from "../../access/access-model";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@vivd-catalyst/ui";
import { CheckTab, GrantsTab, NamespacesTab } from "../../access";
import {
  useAccessMutations,
  useEffectivePermissionsQuery,
  useNamespacesQuery,
  usePermissionGrantsQuery
} from "../../access/access-queries";
import { useConfigAssetsOverviewQuery, useWorkspaceUsersQuery } from "../../api/workspace-queries";
import { useTranslation } from "../../i18n";
import { useSettingsPage } from "../settings-page-context";

/**
 * Instance > Access: the Namespaces of the instance, the grant rows on agents and skills, and
 * what one person may do with one asset. Each tab gets its data from here and shows it.
 */
export function AccessPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const api = { apiBaseUrl, authScope, client };
  const [checkedHolderId, setCheckedHolderId] = useState<string | undefined>();
  const namespacesQuery = useNamespacesQuery(api);
  const grantsQuery = usePermissionGrantsQuery(api);
  const usersQuery = useWorkspaceUsersQuery({ ...api, enabled: true });
  // Tools, models and assets come with the agent configuration, which has its own right. A
  // reader without it still sees and revokes rows; the pickers say what could not be loaded.
  const overviewQuery = useConfigAssetsOverviewQuery({ ...api, enabled: true });
  const effectiveQuery = useEffectivePermissionsQuery({ ...api, holderId: checkedHolderId });
  const mutations = useAccessMutations(api);
  const overview = overviewQuery.data;
  const overviewFailure = loadFailure(overviewQuery.error);
  const retry = (query: { refetch(): Promise<unknown> }) => () => {
    query.refetch().catch(() => undefined);
  };

  return (
    <>
      <PageHeader title={t("settings.access")} description={t("access.description")} />
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
            namespaces={namespacesQuery.data}
            assets={overview?.assets}
            assetsFailure={overviewFailure}
            onGrant={(requests) => mutations.grant.mutateAsync(requests)}
            onRevoke={(grantId) => mutations.revoke.mutateAsync(grantId)}
          />
        </TabsContent>
        <TabsContent value="check" className="pt-5">
          <CheckTab
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
