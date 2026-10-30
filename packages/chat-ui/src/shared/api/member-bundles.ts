import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient, OperationOutcome, WorkspaceBundle } from "@work-shape/catalyst-api-client";
import type { MemberBundleChange } from "@work-shape/catalyst-core";
import { CollaborationWorkspaceChangeHeldError } from "../collaboration-workspace/collaboration-workspace-errors";
import { workspaceQueryKeys } from "./workspace-query-keys";

interface MemberBundlesInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  collaborationWorkspaceId: string;
}

/**
 * Under the members' key, so that every change of the members reads the bundles again too: a
 * member who left holds none here.
 */
function memberBundlesKey(input: MemberBundlesInput) {
  return [
    ...workspaceQueryKeys.collaborationWorkspaceMembers(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspaceId
    ),
    "bundles"
  ] as const;
}

/** Builder and Publisher of each member of a Shared Workspace (AP-3), for its Owner or Admin. */
export function useMemberBundlesQuery(input: MemberBundlesInput & { enabled: boolean }) {
  return useQuery({
    queryKey: memberBundlesKey(input),
    queryFn: async () =>
      (
        await input.client.workspaces.member_bundles.list({
          params: { collaborationWorkspaceId: input.collaborationWorkspaceId }
        })
      ).items,
    enabled: input.enabled
  });
}

/** One switch turned: what it does to one bundle of one member. */
export interface MemberBundleChangeInput {
  userId: string;
  bundle: WorkspaceBundle;
  change: MemberBundleChange;
  /** The open request a withdrawal ends. */
  requestId?: string;
}

function changed<Output>(outcome: OperationOutcome<Output>): Output {
  if (outcome.status === "done") return outcome.output;
  throw new CollaborationWorkspaceChangeHeldError();
}

/**
 * Turns a switch: asks for the bundle, gives it at once, takes it back, or withdraws the
 * caller's request. The list is read again afterwards, whether it worked or not.
 */
export function useMemberBundleChange(input: MemberBundlesInput) {
  const queryClient = useQueryClient();
  const { client, collaborationWorkspaceId } = input;
  return useMutation({
    mutationFn: async ({ userId, bundle, change, requestId }: MemberBundleChangeInput) => {
      const params = { collaborationWorkspaceId, userId, bundle };
      switch (change) {
        case "request":
          return changed(await client.workspaces.member_bundles.request({ params, body: {} }));
        case "grant":
          return changed(await client.workspaces.member_bundles.grant({ params }));
        case "revoke":
          return changed(await client.workspaces.member_bundles.revoke({ params }));
        case "withdraw":
          if (requestId === undefined) throw new Error("No request to withdraw");
          return client.approval_requests.withdraw({ params: { requestId } });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: memberBundlesKey(input) })
  });
}
