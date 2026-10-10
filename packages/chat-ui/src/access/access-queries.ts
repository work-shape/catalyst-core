import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAll,
  type ApiClient,
  type CreateNamespaceRequest,
  type CreatePermissionGrantRequest,
  type UpdateNamespaceRequest
} from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { GrantWriteError } from "./access-model";

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

export function usePermissionGrantsQuery(input: AccessApiInput) {
  return useQuery({
    queryKey: accessQueryKeys.grants(input.apiBaseUrl, input.authScope),
    queryFn: () => listAll((paging) => input.client.permissions.list({ query: paging }))
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
  /** One row per request, in order. It stops at the first refusal and says how far it came. */
  const grant = useMutation({
    mutationFn: async (requests: readonly CreatePermissionGrantRequest[]) => {
      let written = 0;
      for (const request of requests) {
        try {
          await input.client.permissions.grant({ body: request });
        } catch (error) {
          throw new GrantWriteError(request, written, requests.length, error);
        }
        written += 1;
      }
    },
    onSettled: refresh
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => input.client.permissions.revoke({ params: { grantId } }),
    onSettled: refresh
  });

  return { createNamespace, updateNamespace, deleteNamespace, grant, revoke };
}
