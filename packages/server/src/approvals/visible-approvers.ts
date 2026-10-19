import {
  asUserId,
  authenticatedUserFromRecord,
  type ApprovalRequest,
  type ApprovalRequestHandler,
  type AuthenticatedUser,
  type AccessResource
} from "@work-shape/catalyst-core";
import { resourceOfRequest } from "./approval-request-service";
import type { ChatServerOptions } from "../types";

// Help text names a few alternatives, never the whole user directory.
const APPROVER_NAMES_MAX = 3;
// Bound live permission resolutions on opening one item; unnamed alternatives remain possible.
const APPROVER_CANDIDATES_MAX = 20;
// Bound membership reads for this optional hint; other visible approvers may remain unnamed.
const APPROVER_WORKSPACES_MAX = 20;

/** Only co-members the requester can see are considered; every named person's right is current. */
export async function visibleApproverNames(
  options: Pick<ChatServerOptions, "authorizer" | "clientInstanceId" | "stores">,
  user: AuthenticatedUser,
  handler: ApprovalRequestHandler,
  request: ApprovalRequest
): Promise<string[]> {
  return visibleApproverNamesFor(
    options,
    user,
    handler.requiredPermission,
    resourceOfRequest(handler, request)
  );
}

/** The same deciding people before a request exists, for an authorized save preview. */
export async function visibleApproverNamesFor(
  options: Pick<ChatServerOptions, "authorizer" | "clientInstanceId" | "stores">,
  user: AuthenticatedUser,
  permission: string,
  resource?: AccessResource
): Promise<string[]> {
  if (!options.authorizer) return [];
  const clientInstanceId = options.clientInstanceId;
  const workspaces = await options.stores.workspaces.listWorkspacesForUser({
    clientInstanceId,
    userId: asUserId(user.id)
  });
  const candidates = new Set<string>();
  for (const workspace of workspaces
    .filter((workspace) => workspace.kind === "shared")
    .slice(0, APPROVER_WORKSPACES_MAX)) {
    const members = await options.stores.workspaces.listMemberships({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id
    });
    // Workspace managers are the most useful first people to ask, but need the approval right too.
    members.sort((a, b) => Number(a.role === "member") - Number(b.role === "member"));
    for (const member of members) {
      if (member.userId !== user.id) candidates.add(member.userId);
      if (candidates.size >= APPROVER_CANDIDATES_MAX) break;
    }
    if (candidates.size >= APPROVER_CANDIDATES_MAX) break;
  }
  const names: string[] = [];
  for (const id of candidates) {
    const record = await options.stores.users.getUser({ clientInstanceId, userId: asUserId(id) });
    // An account without a person's name is left unnamed; an e-mail is never help text.
    if (
      !record ||
      record.status !== "active" ||
      !record.displayLabel.trim() ||
      record.displayLabel.includes("@")
    )
      continue;
    const actor = authenticatedUserFromRecord({
      user: record,
      identity: { authSource: "approval-help", externalUserId: record.id }
    });
    const access = await options.authorizer.forActor(actor);
    if (access.authorize(permission, resource).allowed) {
      if (!names.includes(record.displayLabel)) names.push(record.displayLabel);
      if (names.length === APPROVER_NAMES_MAX) break;
    }
  }
  return names;
}
