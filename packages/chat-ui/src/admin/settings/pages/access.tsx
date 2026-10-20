import { DataScopes } from "../../access/data-scopes";
// @rights-screen: included in the rights wording guard.
import { useState } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import {
  furtherGrantKinds,
  grantRowCount,
  grantsNameWorkspaces,
  loadFailure,
  type GrantKind
} from "../../access/access-model";
import type { GrantChoices } from "../../access/grants-tab";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@work-shape/catalyst-ui";
import { CheckTab, GrantsTab } from "../../access";
import {
  listGrantChoiceAssets,
  useAccessMutations,
  useEffectivePermissionsQuery,
  usePermissionGrantsQuery
} from "../../access/access-queries";
import { useQueries, useQuery } from "@tanstack/react-query";
import { listAll } from "@work-shape/catalyst-api-client";
import {
  useConfigAssetsOverviewQuery,
  usePlatformContextQuery,
  useWorkspaceUsersQuery
} from "../../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../../shared/api/workspace-query-keys";
import { DocsReference } from "../../../shared/docs-links";
import { useTranslation } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";

/**
 * Instance > Access: the grant rows on the assets of every kind a right can be given on, and
 * what one person may do with one asset. Each tab gets its data from here and shows it.
 */
export function AccessPage() {
  const { t, locale } = useTranslation();
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const api = { apiBaseUrl, authScope, client };
  const [checkedHolderId, setCheckedHolderId] = useState<string | undefined>();
  const [checkedKind, setCheckedKind] = useState("agent");
  const grantsQuery = usePermissionGrantsQuery(api);
  const usersQuery = useWorkspaceUsersQuery({ ...api, enabled: true });
  // Assets come with the agent configuration, which has its own right. A
  // reader without it still sees and revokes rows; the pickers say what could not be loaded.
  const overviewQuery = useConfigAssetsOverviewQuery({ ...api, enabled: true });
  const giverQuery = useEffectivePermissionsQuery({ ...api, holderId: user.id });
  const effectiveQuery = useEffectivePermissionsQuery({ ...api, holderId: checkedHolderId });
  // A grant names a kind beyond agents and skills while the instance has the kind: its module
  // is on. Which kinds a grant can name at all, core says.
  const contextQuery = usePlatformContextQuery({ ...api, enabled: true });
  const furtherKinds = furtherGrantKinds(contextQuery.data?.kinds.map((kind) => kind.kind));
  // An App or a Data Store is listed in the workspace that owns it, so the picker asks each
  // Shared Workspace the reader can use something in, beside the instance's own assets.
  const sharedWorkspaceIds = (contextQuery.data?.workspaces ?? [])
    .filter((workspace) => workspace.kind === "shared")
    .map((workspace) => workspace.id);
  const ownersOf = (kind: GrantKind) =>
    contextQuery.data?.kinds.find((candidate) => candidate.kind === kind)?.owners ?? ["instance"];
  const grantKinds: GrantKind[] = ["agent", "skill", ...furtherKinds];
  const kindAssetQueries = useQueries({
    queries: grantKinds.map((kind) => ({
      queryKey: [
        ...workspaceQueryKeys.assets(apiBaseUrl, authScope),
        "choice",
        kind,
        locale,
        ...sharedWorkspaceIds
      ],
      queryFn: () =>
        listGrantChoiceAssets(client, {
          kind,
          owners: ownersOf(kind),
          workspaceIds: sharedWorkspaceIds,
          locale
        }),
      enabled: contextQuery.data !== undefined,
      retry: false
    }))
  });
  const assetChoices: Partial<Record<GrantKind, GrantChoices>> = Object.fromEntries(
    grantKinds.map((kind, index) => {
      const query = kindAssetQueries[index];
      const loaded =
        query?.data?.map((asset) => ({
          id: asset.id,
          resource: {
            kind: asset.kind,
            name: asset.name,
            assetId: asset.id,
            ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
          },
          // The display name, with the id the rows list it by and what it says of itself.
          name: asset.title,
          description: asset.description ? `${asset.name} · ${asset.description}` : asset.name
        })) ?? [];
      // An asset-only holder need not be a workspace member. Their own grant rows can name
      // such an asset even when platform.context offers no workspace-wide action there.
      const heldAssets = (grantsQuery.data ?? []).flatMap((grant) =>
        grant.holderKind === "user" &&
        grant.holderId === user.id &&
        grant.scopeKind === "asset" &&
        grant.scopeId !== undefined &&
        grant.scopeAsset?.kind === kind &&
        grant.scopeAsset.active &&
        !loaded.some((asset) => asset.id === grant.scopeId)
          ? [{ id: grant.scopeId, name: grant.scopeAsset.name ?? grant.scopeId }]
          : []
      );
      return [
        kind,
        {
          items:
            query?.data === undefined && grantsQuery.data === undefined
              ? undefined
              : [...loaded, ...new Map(heldAssets.map((asset) => [asset.id, asset])).values()],
          failed: Boolean(query?.error)
        }
      ];
    })
  );
  // Builder and Publisher name a workspace, never an asset.
  const kindAssets = { ...assetChoices, workspace: { items: [], failed: false } };
  const namesWorkspaces = grantsNameWorkspaces(furtherKinds, grantsQuery.data ?? []);
  // The Check tab asks about every kind the instance has. Agents and skills come with the
  // agent configuration; the assets of any other kind are listed once the kind is chosen.
  const checkedOtherKind =
    checkedKind !== "agent" &&
    checkedKind !== "skill" &&
    Boolean(contextQuery.data?.kinds.some((kind) => kind.kind === checkedKind));
  const checkedKindAssetsQuery = useQuery({
    queryKey: [...workspaceQueryKeys.assets(apiBaseUrl, authScope), "choice", checkedKind, locale],
    queryFn: () =>
      listAll((paging) =>
        client.assets.list({ params: { kind: checkedKind }, query: { ...paging, locale } })
      ),
    enabled: checkedOtherKind,
    retry: false
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
      <Tabs defaultValue="grants">
        <TabsList label={t("access.tabs")}>
          <TabsTrigger value="grants" count={grantRowCount(grantsQuery.data)}>
            {t("access.tabGrants")}
          </TabsTrigger>
          <TabsTrigger value="data-scopes">{t("access.scopeTab")}</TabsTrigger>
          <TabsTrigger value="check">{t("access.tabCheck")}</TabsTrigger>
        </TabsList>
        <TabsContent value="grants" className="pt-5">
          <GrantsTab
            giver={giverQuery.error === null ? giverQuery.data : undefined}
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
                    items: contextQuery.data?.workspaces
                      .filter((workspace) => workspace.kind === "shared")
                      .map((workspace) => ({
                        id: workspace.id,
                        name: workspace.name
                      })),
                    failed: Boolean(contextQuery.error)
                  }
                : undefined
            }
            instanceAdminName={user.instanceAdminName}
            onGrant={(requests) => mutations.grant.mutateAsync(requests)}
            onRevoke={(grantId) => mutations.revoke.mutateAsync(grantId)}
          />
        </TabsContent>
        <TabsContent value="data-scopes" className="pt-5">
          <DataScopes client={client} userId={user.id} users={usersQuery.data} />
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
            instanceAdminName={user.instanceAdminName}
            titleOf={(assetId) =>
              Object.values(kindAssets)
                .flatMap((choices) => choices?.items ?? [])
                .find((asset) => asset.id === assetId)?.name
            }
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
