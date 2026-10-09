import { useEffect } from "react";
import { useApiAccessMutations } from "../../api/workspace-mutations";
import { useServicePrincipalsQuery } from "../../api/workspace-queries";
import { ApiAccessPanel } from "../../control-plane/api-access-panel";
import { createApiAccessAuthorityKey } from "../../control-plane/api-access-reveal-controller";
import { apiErrorMessage } from "../../workspace-utils";
import { useSettingsPage } from "../settings-page-context";

/** Instance > API access: the service principals and their keys, with its own data. */
export function ApiAccessPage() {
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const canManageSuperadminAccess = user.roles.includes("superadmin");
  const servicePrincipalsQuery = useServicePrincipalsQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });
  const apiAccessMutations = useApiAccessMutations({
    apiBaseUrl,
    authScope,
    client,
    authorityKey: createApiAccessAuthorityKey({
      apiBaseUrl,
      principalId: user.id,
      canManageSuperadminAccess
    })
  });
  const { clearRevealedCredential } = apiAccessMutations;

  useEffect(() => {
    if (!canManageSuperadminAccess) {
      clearRevealedCredential();
    }
  }, [clearRevealedCredential, canManageSuperadminAccess]);

  return (
    <ApiAccessPanel
      canMutate={canManageSuperadminAccess}
      principals={servicePrincipalsQuery.data ?? []}
      revealedCredential={apiAccessMutations.revealedCredential}
      loading={servicePrincipalsQuery.isLoading}
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
}
