import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAll,
  type ApiClient,
  type CreateNamespaceRequest,
  type CreatePermissionGrantRequest,
  type UpdateNamespaceRequest
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { accessWriteFailure, GrantWriteError, type GrantWriteResult } from "./access-model";
import { PrincipalGrantHeldError, principalGrantRequest } from "./principal-grants-model";

interface AccessApiInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

const accessQueryKeys = {
  all: (apiBaseUrl: string, authScope: string) => ["access", apiBaseUrl, authScope] as const,
  namespaces: (apiBaseUrl: string, authScope: string) =>
    ["access", apiBaseUrl, authScope, "namespaces"] as const,
  grants: (apiBaseUrl: string, authScope: string) =>
    ["access", apiBaseUrl, authScope, "grants"] as const,
  effective: (apiBaseUrl: string, authScope: string, holderId: string | undefined) =>
    ["access", apiBaseUrl, authScope, "effective", holderId] as const
};

export function useNamespacesQuery(input: AccessApiInput) {
  return useQuery({
    queryKey: accessQueryKeys.namespaces(input.apiBaseUrl, input.authScope),
    queryFn: () => listAll((paging) => input.client.namespaces.list({ query: paging }))
  });
}

/**
 * The rows users hold. A service principal's rows are listed for a caller who may see service
 * principals; this page names its holders from the user list and shows none of them.
 */
export function usePermissionGrantsQuery(input: AccessApiInput) {
  return useQuery({
    queryKey: accessQueryKeys.grants(input.apiBaseUrl, input.authScope),
    queryFn: () =>
      listAll((paging) =>
        input.client.permissions.list({ query: { ...paging, holderKind: "user" } })
      )
  });
}

/** The rows one service principal holds. Read by who is shown service principals. */
export function usePrincipalGrantsQuery(input: AccessApiInput & { principalId: string }) {
  const { principalId } = input;
  return useQuery({
    queryKey: [...accessQueryKeys.grants(input.apiBaseUrl, input.authScope), "of", principalId],
    queryFn: () =>
      listAll((paging) =>
        input.client.permissions.list({
          query: { ...paging, holderKind: "service_principal", holderId: principalId }
        })
      ),
    retry: false
  });
}

/**
 * The rows that name one asset: who holds a right on it. A service principal's rows are among
 * them for a reader who is shown service principals, and left out without a word for anyone else.
 */
export function useAssetGrantsQuery(
  input: AccessApiInput & { assetId: string; action: string; enabled: boolean }
) {
  const { assetId, action } = input;
  return useQuery({
    queryKey: [...accessQueryKeys.grants(input.apiBaseUrl, input.authScope), "on", assetId, action],
    queryFn: () =>
      listAll((paging) =>
        input.client.permissions.list({
          query: { ...paging, scopeKind: "asset", scopeId: assetId, action }
        })
      ),
    enabled: input.enabled,
    retry: false
  });
}

/** Everything that allows or denies one user something. Asked once a user is chosen. */
export function useEffectivePermissionsQuery(input: AccessApiInput & { holderId?: string }) {
  const { holderId } = input;
  return useQuery({
    queryKey: accessQueryKeys.effective(input.apiBaseUrl, input.authScope, holderId),
    queryFn: () =>
      input.client.permissions.effective({
        query: { holderKind: "user", holderId: holderId ?? "" }
      }),
    enabled: holderId !== undefined,
    retry: false
  });
}

/** The writes of the page. Each one reads the lists again, whether it succeeded or not. */
export function useAccessMutations(input: AccessApiInput) {
  const queryClient = useQueryClient();
  const refresh = () => {
    // A list that cannot be read again shows its own error; the write itself is done.
    const read = [
      accessQueryKeys.all(input.apiBaseUrl, input.authScope),
      workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
    ];
    for (const queryKey of read) {
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
    }
  };

  const createNamespace = useMutation({
    mutationFn: (body: CreateNamespaceRequest) => input.client.namespaces.create({ body }),
    onSettled: refresh
  });
  const updateNamespace = useMutation({
    mutationFn: (update: { prefix: string; body: UpdateNamespaceRequest }) =>
      input.client.namespaces.update({ params: { prefix: update.prefix }, body: update.body }),
    onSettled: refresh
  });
  const deleteNamespace = useMutation({
    mutationFn: (prefix: string) => input.client.namespaces.delete({ params: { prefix } }),
    onSettled: refresh
  });
  /**
   * One row per request, in order. A row that exists already is left as it is, so sending a
   * form again after it stopped half way adds what is missing. It stops at any other refusal
   * and says how far it came.
   */
  const grant = useMutation({
    mutationFn: async (
      requests: readonly CreatePermissionGrantRequest[]
    ): Promise<GrantWriteResult> => {
      let added = 0;
      let existing = 0;
      for (const request of requests) {
        try {
          await input.client.permissions.grant({ body: request });
          added += 1;
        } catch (error) {
          if (accessWriteFailure(error) !== "duplicateGrant") {
            throw new GrantWriteError(request, added, requests.length, error);
          }
          existing += 1;
        }
      }
      return { added, existing };
    },
    onSettled: refresh
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => input.client.permissions.revoke({ params: { grantId } }),
    onSettled: refresh
  });

  return { createNamespace, updateNamespace, deleteNamespace, grant, revoke };
}

/**
 * Giving a service principal a right on one resource, and removing one. A write that waits for
 * somebody else's approval changed nothing, and says so. Each one reads the rows again.
 */
export function usePrincipalGrantMutations(input: AccessApiInput & { principalId: string }) {
  const queryClient = useQueryClient();
  const refresh = () => {
    for (const queryKey of [
      accessQueryKeys.all(input.apiBaseUrl, input.authScope),
      workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
    ]) {
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
    }
  };
  const give = useMutation({
    mutationFn: async (right: { action: string; assetId: string }) => {
      const outcome = await input.client.permissions.grant({
        body: principalGrantRequest({ principalId: input.principalId, ...right })
      });
      if (outcome.status !== "done") {
        throw new PrincipalGrantHeldError();
      }
    },
    onSettled: refresh
  });
  const remove = useMutation({
    mutationFn: async (grantId: string) => {
      const outcome = await input.client.permissions.revoke({ params: { grantId } });
      if (outcome.status !== "done") {
        throw new PrincipalGrantHeldError();
      }
    },
    onSettled: refresh
  });
  return { give, remove };
}
