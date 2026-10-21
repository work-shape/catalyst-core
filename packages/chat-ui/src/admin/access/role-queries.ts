import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type OperationOutcome,
  type RoleGrantInput
} from "@work-shape/catalyst-api-client";
import type { RolePendingDecision } from "@work-shape/catalyst-core";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";

interface RoleApiInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

/** Under the Access page's own keys, so every write of the page reads the roles again too. */
const roleQueryKeys = {
  access: (apiBaseUrl: string, authScope: string) => ["access", apiBaseUrl, authScope] as const,
  roles: (apiBaseUrl: string, authScope: string) =>
    ["access", apiBaseUrl, authScope, "roles"] as const
};

/** The roles of the instance: the three built-in ones, then the custom roles by name. */
export function useRolesQuery(input: RoleApiInput & { enabled?: boolean }) {
  return useQuery({
    queryKey: roleQueryKeys.roles(input.apiBaseUrl, input.authScope),
    queryFn: async () => (await input.client.roles.list()).items,
    enabled: input.enabled ?? true,
    retry: false
  });
}

/**
 * The writes of the Roles tab. Each one reads the roles, the rights and the audit log again,
 * whether it succeeded or not. A write that waits for an approval changed nothing, and throws
 * `heldMessage`.
 */
export function useRoleMutations(input: RoleApiInput & { heldMessage: string }) {
  const queryClient = useQueryClient();
  const { client, heldMessage } = input;
  const refresh = () => {
    for (const queryKey of [
      roleQueryKeys.access(input.apiBaseUrl, input.authScope),
      workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
    ]) {
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
    }
  };
  const done = <Output>(outcome: OperationOutcome<Output>) => completedOutput(outcome, heldMessage);

  const create = useMutation({
    mutationFn: async (body: { name: string; description?: string; grants: RoleGrantInput[] }) =>
      done(await client.roles.create({ body })),
    onSettled: refresh
  });
  const update = useMutation({
    mutationFn: async ({
      roleId,
      body
    }: {
      roleId: string;
      body: { name?: string; description?: string | null; grants?: RoleGrantInput[] };
    }) => done(await client.roles.update({ params: { roleId }, body })),
    onSettled: refresh
  });
  const remove = useMutation({
    mutationFn: async (roleId: string) => done(await client.roles.delete({ params: { roleId } })),
    onSettled: refresh
  });
  const reset = useMutation({
    mutationFn: async (roleId: string) => done(await client.roles.reset({ params: { roleId } })),
    onSettled: refresh
  });
  const decide = useMutation({
    mutationFn: async ({
      roleId,
      action,
      decision
    }: {
      roleId: string;
      action: string;
      decision: RolePendingDecision;
    }) =>
      done(await client.roles.pending.decide({ params: { roleId }, body: { action, decision } })),
    onSettled: refresh
  });
  return { create, update, remove, reset, decide };
}
