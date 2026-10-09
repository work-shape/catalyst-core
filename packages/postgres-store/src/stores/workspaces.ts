import {
  type ClientInstanceId,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId,
  type CollaborationWorkspaceStore,
  type CollaborationWorkspaceWithRole,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  type WorkspaceMemberCandidate,
  type WorkspaceMembership,
  type WorkspaceAccessRequest
} from "@vivd-catalyst/core";
import {
  addMembership as addPostgresMembership,
  createAccessRequest as createPostgresAccessRequest,
  createWorkspace as createPostgresWorkspace,
  deleteAccessRequest as deletePostgresAccessRequest,
  deleteAccessRequestsForUser as deletePostgresAccessRequestsForUser,
  deletePersonalWorkspaceForUser as deletePostgresPersonalWorkspaceForUser,
  deleteWorkspace as deletePostgresWorkspace,
  ensurePersonalWorkspace as ensurePostgresPersonalWorkspace,
  getAccessRequest as getPostgresAccessRequest,
  getMembership as getPostgresMembership,
  getWorkspace as getPostgresWorkspace,
  listAccessRequestsForWorkspace as listPostgresAccessRequestsForWorkspace,
  listDiscoverableWorkspaces as listPostgresDiscoverableWorkspaces,
  listMemberships as listPostgresMemberships,
  listSharedWorkspaces as listPostgresSharedWorkspaces,
  searchMemberCandidates as searchPostgresMemberCandidates,
  listWorkspacesForUser as listPostgresWorkspacesForUser,
  removeMembership as removePostgresMembership,
  removeMembershipsForUser as removePostgresMembershipsForUser,
  updateMembershipRole as updatePostgresMembershipRole,
  updateWorkspace as updatePostgresWorkspace
} from "../postgres-collaboration-workspace-operations";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresWorkspacesStore(db: PostgresConnection): CollaborationWorkspaceStore {
  return {
    async createWorkspace(input: CreateWorkspaceInput): Promise<CollaborationWorkspace> {
      return createPostgresWorkspace(db, input);
    },
    async getWorkspace(
      clientInstanceId: ClientInstanceId,
      collaborationWorkspaceId: CollaborationWorkspaceId
    ): Promise<CollaborationWorkspace | undefined> {
      return getPostgresWorkspace(db, clientInstanceId, collaborationWorkspaceId);
    },
    async listWorkspacesForUser(
      input: Parameters<CollaborationWorkspaceStore["listWorkspacesForUser"]>[0]
    ): Promise<CollaborationWorkspaceWithRole[]> {
      return listPostgresWorkspacesForUser(db, input);
    },
    async listDiscoverableWorkspaces(
      input: Parameters<CollaborationWorkspaceStore["listDiscoverableWorkspaces"]>[0]
    ): Promise<CollaborationWorkspace[]> {
      return listPostgresDiscoverableWorkspaces(db, input);
    },
    async listSharedWorkspaces(
      input: Parameters<CollaborationWorkspaceStore["listSharedWorkspaces"]>[0]
    ): Promise<CollaborationWorkspace[]> {
      return listPostgresSharedWorkspaces(db, input);
    },
    async updateWorkspace(input: UpdateWorkspaceInput): Promise<CollaborationWorkspace> {
      return updatePostgresWorkspace(db, input);
    },
    async deleteWorkspace(
      input: Parameters<CollaborationWorkspaceStore["deleteWorkspace"]>[0]
    ): Promise<CollaborationWorkspace> {
      return deletePostgresWorkspace(db, input);
    },
    async ensurePersonalWorkspace(
      input: Parameters<CollaborationWorkspaceStore["ensurePersonalWorkspace"]>[0]
    ): Promise<CollaborationWorkspace> {
      return ensurePostgresPersonalWorkspace(db, input);
    },
    async addMembership(
      input: Parameters<CollaborationWorkspaceStore["addMembership"]>[0]
    ): Promise<WorkspaceMembership> {
      return addPostgresMembership(db, input);
    },
    async updateMembershipRole(
      input: Parameters<CollaborationWorkspaceStore["updateMembershipRole"]>[0]
    ): Promise<WorkspaceMembership> {
      return updatePostgresMembershipRole(db, input);
    },
    async removeMembership(
      input: Parameters<CollaborationWorkspaceStore["removeMembership"]>[0]
    ): Promise<WorkspaceMembership> {
      return removePostgresMembership(db, input);
    },
    async listMemberships(
      input: Parameters<CollaborationWorkspaceStore["listMemberships"]>[0]
    ): Promise<WorkspaceMembership[]> {
      return listPostgresMemberships(db, input);
    },
    async searchMemberCandidates(
      input: Parameters<CollaborationWorkspaceStore["searchMemberCandidates"]>[0]
    ): Promise<WorkspaceMemberCandidate[]> {
      return searchPostgresMemberCandidates(db, input);
    },
    async getMembership(
      input: Parameters<CollaborationWorkspaceStore["getMembership"]>[0]
    ): Promise<WorkspaceMembership | undefined> {
      return getPostgresMembership(db, input);
    },
    async createAccessRequest(
      input: Parameters<CollaborationWorkspaceStore["createAccessRequest"]>[0]
    ): Promise<WorkspaceAccessRequest> {
      return createPostgresAccessRequest(db, input);
    },
    async deleteAccessRequest(
      input: Parameters<CollaborationWorkspaceStore["deleteAccessRequest"]>[0]
    ): Promise<WorkspaceAccessRequest> {
      return deletePostgresAccessRequest(db, input);
    },
    async listAccessRequestsForWorkspace(
      input: Parameters<CollaborationWorkspaceStore["listAccessRequestsForWorkspace"]>[0]
    ): Promise<WorkspaceAccessRequest[]> {
      return listPostgresAccessRequestsForWorkspace(db, input);
    },
    async getAccessRequest(
      input: Parameters<CollaborationWorkspaceStore["getAccessRequest"]>[0]
    ): Promise<WorkspaceAccessRequest | undefined> {
      return getPostgresAccessRequest(db, input);
    },
    async deleteAccessRequestsForUser(
      input: Parameters<CollaborationWorkspaceStore["deleteAccessRequestsForUser"]>[0]
    ): Promise<number> {
      return deletePostgresAccessRequestsForUser(db, input);
    },
    async removeMembershipsForUser(
      input: Parameters<CollaborationWorkspaceStore["removeMembershipsForUser"]>[0]
    ): Promise<number> {
      return removePostgresMembershipsForUser(db, input);
    },
    async deletePersonalWorkspaceForUser(
      input: Parameters<CollaborationWorkspaceStore["deletePersonalWorkspaceForUser"]>[0]
    ): Promise<CollaborationWorkspace> {
      return deletePostgresPersonalWorkspaceForUser(db, input);
    }
  };
}
