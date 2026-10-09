import type { ApiUser, CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";

export function settingsUser(overrides: Partial<ApiUser> = {}): ApiUser {
  return {
    id: "user_1",
    clientInstanceId: "client",
    authSource: "better-auth",
    externalUserId: "user_1",
    displayLabel: "Felix Pahlke",
    email: "felix@example.com",
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    ...overrides
  };
}

export function sharedWorkspace(
  overrides: Partial<CollaborationWorkspaceWithRole> = {}
): CollaborationWorkspaceWithRole {
  return {
    id: "cw_shared",
    clientInstanceId: "client",
    kind: "shared",
    name: "Produktteam",
    description: "Alles rund um das Produkt",
    visibility: "discoverable",
    defaultConversationVisibility: "workspace",
    emoji: "🚀",
    accentColor: "violet",
    personalUserId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    role: "owner",
    membershipRole: "owner",
    pendingAccessRequestCount: 0,
    ...overrides
  };
}

export function personalWorkspace(): CollaborationWorkspaceWithRole {
  return sharedWorkspace({
    id: "cw_personal",
    kind: "personal",
    name: "Felix Pahlke",
    description: null,
    visibility: "private",
    emoji: null,
    accentColor: null,
    personalUserId: "user_1"
  });
}
