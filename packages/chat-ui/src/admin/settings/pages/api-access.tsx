// @rights-screen: included in the rights wording guard.
import { useQueries } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ServicePrincipalDetail } from "@work-shape/catalyst-api-client";
import { Banner, Section } from "@work-shape/catalyst-ui";
import { loadFailure } from "../../access/access-model";
import {
  listGrantChoiceAssets,
  useEffectivePermissionsQuery,
  usePrincipalGrantMutations,
  usePrincipalGrantsQuery
} from "../../access/access-queries";
import {
  principalGrantKinds,
  principalGrantViews,
  principalOfSearch,
  readerHolds
} from "../../access/principal-grants-model";
import { PrincipalRights } from "../../access/principal-rights";
import {
  useInstancePersonalApiKeysQuery,
  useRevokePersonalApiKeyMutation
} from "../../../shared/api/personal-api-keys";
import { useApiAccessMutations } from "../../../shared/api/workspace-mutations";
import {
  useAdministeredCollaborationWorkspacesQuery,
  usePlatformContextQuery,
  useServicePrincipalsQuery,
  useWorkspaceUsersQuery
} from "../../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../../shared/api/workspace-query-keys";
import { ApiAccessPanel } from "../../control-plane/api-access-panel";
import { createApiAccessAuthorityKey } from "../../../shared/api/api-access-reveal-controller";
import {
  canManageApiAccess,
  canManageServicePrincipals,
  canManageUsers
} from "../../../shared/governance";
import { PersonalApiKeysTable } from "../../control-plane/personal-api-keys-list";
import { useTranslation } from "../../../shared/i18n";
import { apiErrorMessage } from "../../../shared/workspace-utils";
import { useSettingsPage } from "../../../shared/settings-page-context";

/**
 * Instance > API access: the service principals and their keys, with its own data, and every
 * person's own keys where the instance runs them. Principals are shown to and changed by a
 * holder of `service_principals.manage`, their keys issued and revoked by a holder of
 * `api_access.manage`.
 */
export function ApiAccessPage() {
  const { apiBaseUrl, authScope, client, config, user } = useSettingsPage();
  const { t } = useTranslation();
  const contextQuery = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true });
  const may = {
    principals: canManageServicePrincipals(contextQuery.data),
    keys: canManageApiAccess(user)
  };
  const servicePrincipalsQuery = useServicePrincipalsQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: may.principals
  });
  const apiAccessMutations = useApiAccessMutations({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("apiAccessWaitsForApproval"),
    authorityKey: createApiAccessAuthorityKey({
      apiBaseUrl,
      principalId: user.id,
      canIssueKeys: may.keys
    })
  });
  const { clearRevealedCredential } = apiAccessMutations;
  // A link to one principal, such as the one on a Connection's page, opens the page on it.
  const [initialPrincipalId] = useState(() => principalOfSearch(window.location.search));

  useEffect(() => {
    if (!may.keys) {
      clearRevealedCredential();
    }
  }, [clearRevealedCredential, may.keys]);

  const panel = (
    <ApiAccessPanel
      may={may}
      principals={servicePrincipalsQuery.data ?? []}
      initialPrincipalId={initialPrincipalId}
      renderRights={(detail) => (
        <PrincipalRightsOnInstance
          key={detail.principal.id}
          detail={detail}
          canMutate={may.principals}
        />
      )}
      revealedCredential={apiAccessMutations.revealedCredential}
      loading={contextQuery.isPending || servicePrincipalsQuery.isLoading}
      error={
        servicePrincipalsQuery.error
          ? apiErrorMessage(servicePrincipalsQuery.error, undefined)
          : undefined
      }
      mutating={apiAccessMutations.isPending}
      onCreatePrincipal={(input) => apiAccessMutations.createPrincipal.mutateAsync(input)}
      onUpdatePrincipal={(principalId, update) =>
        apiAccessMutations.updatePrincipal.mutateAsync({ principalId, update })
      }
      onCreateCredential={(principalId, credential) =>
        apiAccessMutations.createCredential.mutateAsync({ principalId, credential })
      }
      onRevokeCredential={(credentialId) =>
        apiAccessMutations.revokeCredential.mutateAsync(credentialId)
      }
      onClearRevealedCredential={clearRevealedCredential}
    />
  );
  // Every person's own keys are listed to a holder of `api_access.manage` alone.
  return config.modules.personalApiKeys?.enabled && may.keys ? (
    <>
      {panel}
      <PersonalKeysOnInstance />
    </>
  ) : (
    panel
  );
}

/** Every person's own API keys, revoked here by a holder of `api_access.manage`. */
function PersonalKeysOnInstance() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const api = { apiBaseUrl, authScope, client };
  const keysQuery = useInstancePersonalApiKeysQuery({ ...api, enabled: true });
  const revoke = useRevokePersonalApiKeyMutation({
    ...api,
    heldMessage: t("apiAccessWaitsForApproval")
  });

  return (
    <Section
      layout="stacked"
      title={t("personalApiKeys.instanceTitle")}
      description={t("personalApiKeys.instanceDescription")}
      count={keysQuery.data?.length}
    >
      {keysQuery.error ? (
        <Banner tone="danger">
          {apiErrorMessage(keysQuery.error, t("settings.requestFailed"))}
        </Banner>
      ) : (
        <PersonalApiKeysTable
          keys={keysQuery.data ?? []}
          loading={keysQuery.isPending}
          showOwner
          revoking={revoke.isPending}
          onRevoke={(key) => revoke.mutateAsync(key.id)}
        />
      )}
    </Section>
  );
}

/**
 * What one principal may use, on the instance's own answers: its rows, the kinds and rights
 * the instance hands out, and the resources of those kinds the reader is shown.
 */
function PrincipalRightsOnInstance({
  detail,
  canMutate
}: {
  detail: ServicePrincipalDetail;
  canMutate: boolean;
}) {
  const { locale } = useTranslation();
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const api = { apiBaseUrl, authScope, client };
  const { principal } = detail;
  const grantsQuery = usePrincipalGrantsQuery({ ...api, principalId: principal.id });
  const contextQuery = usePlatformContextQuery({ ...api, enabled: true });
  const kinds = principalGrantKinds(contextQuery.data);
  // One list per kind, shared with the Access page: the names of the rows and the dialog's choices.
  const resourceQueries = useQueries({
    queries: kinds.map(({ kind }) => ({
      queryKey: [...workspaceQueryKeys.assets(apiBaseUrl, authScope), "choice", kind, locale],
      queryFn: () =>
        listGrantChoiceAssets(client, { kind, owners: ["instance"], workspaceIds: [], locale }),
      retry: false
    }))
  });
  const resourcesLoaded = resourceQueries.every((query) => query.data !== undefined);
  const resources = resourceQueries.flatMap((query) => query.data ?? []);
  const workspacesQuery = useAdministeredCollaborationWorkspacesQuery({ ...api, enabled: true });
  const workspaces = workspacesQuery.data ?? [];
  // Who gave a right is named only for a reader who may read users. Everyone may read
  // their own entries, so the dialog offers only what they hold.
  const readsUsers = canManageUsers(user);
  const usersQuery = useWorkspaceUsersQuery({ ...api, enabled: readsUsers });
  const ownRightsQuery = useEffectivePermissionsQuery({
    ...api,
    holderId: user.id
  });
  const mutations = usePrincipalGrantMutations({ ...api, principalId: principal.id });
  const failure = loadFailure(grantsQuery.error);

  return (
    <PrincipalRights
      principal={principal}
      canMutate={canMutate}
      read={
        grantsQuery.data
          ? {
              status: "ready",
              rows: principalGrantViews(grantsQuery.data, {
                assets: resources,
                workspaces,
                users: usersQuery.data ?? []
              })
            }
          : failure === "forbidden"
            ? { status: "forbidden" }
            : failure === "failed"
              ? { status: "failed", retry: () => void grantsQuery.refetch().catch(() => undefined) }
              : { status: "loading" }
      }
      kinds={kinds}
      resources={{
        items: resourcesLoaded ? resources : undefined,
        failed: resourceQueries.some((query) => Boolean(query.error))
      }}
      workspaces={workspaces}
      holds={(action, asset) => readerHolds(ownRightsQuery.data, action, asset)}
      onGive={(right) => mutations.give.mutateAsync(right)}
      onRemove={(grantId) => mutations.remove.mutateAsync(grantId)}
    />
  );
}
