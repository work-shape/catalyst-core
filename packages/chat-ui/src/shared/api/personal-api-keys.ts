import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  completedOutput,
  listAll,
  type ApiClient,
  type ConfirmConnectCodeRequest,
  type CreatePersonalApiKeyRequest,
  type CreatePersonalApiKeyResponse
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

interface PersonalApiKeysInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

/** The signed-in person's own keys, newest first. */
export function useOwnApiKeysQuery(input: PersonalApiKeysInput & { enabled: boolean }) {
  return useQuery({
    queryKey: workspaceQueryKeys.ownApiKeys(input.apiBaseUrl, input.authScope),
    queryFn: () => listAll((paging) => input.client.me.api_keys.list({ query: paging })),
    enabled: input.enabled
  });
}

/** Every person's keys, for the instance's API access page. */
export function useInstancePersonalApiKeysQuery(
  input: PersonalApiKeysInput & { enabled: boolean }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.personalApiKeys(input.apiBaseUrl, input.authScope),
    queryFn: () => listAll((paging) => input.client.personal_api_keys.list({ query: paging })),
    enabled: input.enabled
  });
}

/**
 * What a CLI's connect code asks for, read once the code is whole. A code is short and every
 * read of one counts like a sign-in, so nothing reads it again by itself.
 */
export function useConnectCodeQuery(input: PersonalApiKeysInput & { userCode: string }) {
  return useQuery({
    queryKey: workspaceQueryKeys.connectCode(input.apiBaseUrl, input.authScope, input.userCode),
    queryFn: () => input.client.me.connect_codes.get({ params: { userCode: input.userCode } }),
    enabled: input.userCode.length > 0,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false
  });
}

/**
 * The person's changes of their own keys. Issuing answers the key once and is never held for
 * an approval; it is no query mutation, so the key stays out of the query cache. A revocation
 * or a confirmation that waits for somebody else's approval changed nothing, and is reported
 * as a failure with `heldMessage`.
 */
export function useOwnApiKeyMutations(input: PersonalApiKeysInput & { heldMessage: string }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.ownApiKeys(input.apiBaseUrl, input.authScope)
    });

  const create = async (
    body: CreatePersonalApiKeyRequest
  ): Promise<CreatePersonalApiKeyResponse> => {
    setCreating(true);
    try {
      const response = await input.client.me.api_keys.create({ body });
      await invalidate();
      return response;
    } finally {
      setCreating(false);
    }
  };
  const revoke = useMutation({
    mutationFn: async (keyId: string) =>
      completedOutput(
        await input.client.me.api_keys.revoke({ params: { keyId } }),
        input.heldMessage
      ),
    onSuccess: invalidate
  });
  const confirmConnectCode = useMutation({
    mutationFn: async (mutationInput: { userCode: string; body: ConfirmConnectCodeRequest }) =>
      completedOutput(
        await input.client.me.connect_codes.confirm({
          params: { userCode: mutationInput.userCode },
          body: mutationInput.body
        }),
        input.heldMessage
      ),
    onSuccess: invalidate
  });

  return { create, creating, revoke, confirmConnectCode };
}

/** Revoking any person's key, by a holder of the instance's API access page. */
export function useRevokePersonalApiKeyMutation(
  input: PersonalApiKeysInput & { heldMessage: string }
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (keyId: string) =>
      completedOutput(
        await input.client.personal_api_keys.revoke({ params: { keyId } }),
        input.heldMessage
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.personalApiKeys(input.apiBaseUrl, input.authScope)
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.ownApiKeys(input.apiBaseUrl, input.authScope)
        })
      ])
  });
}
