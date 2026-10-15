import type { StorePage } from "@vivd-catalyst/core";
import {
  type ClientInstanceId,
  type CreateUserInput,
  type DeleteUserInput,
  type DeleteUserIdentityInput,
  type ResolveUserIdentityInput,
  type UpdateUserInput,
  type UpsertUserIdentityInput,
  type UserModelPreference,
  type UserModelPreferenceInput,
  type UserRecord,
  type UserStore
} from "@vivd-catalyst/core";
import { appendAuditEvent as appendPostgresAuditEvent } from "../postgres-audit-usage-operations";
import {
  createUser as createPostgresUser,
  deleteUser as deletePostgresUser,
  deleteUserIdentity as deletePostgresUserIdentity,
  getUserModelPreference as getPostgresUserModelPreference,
  setUserModelPreference as setPostgresUserModelPreference,
  getUserRecord as getPostgresUserRecord,
  listUsers as listPostgresUsers,
  markUserDeletionRequested as markPostgresUserDeletionRequested,
  resolveUserIdentity as resolvePostgresUserIdentity,
  updateUser as updatePostgresUser,
  upsertUserIdentity as upsertPostgresUserIdentity
} from "../postgres-user-operations";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresUsersStore(db: PostgresConnection): UserStore {
  return {
    async resolveUserIdentity(input: ResolveUserIdentityInput) {
      return resolvePostgresUserIdentity(db, input, (event) => appendPostgresAuditEvent(db, event));
    },
    async getUser(input: Parameters<UserStore["getUser"]>[0]): Promise<UserRecord | undefined> {
      return getPostgresUserRecord(db, input.clientInstanceId, input.userId);
    },
    async listUsers(input: {
      clientInstanceId: ClientInstanceId;
      page?: StorePage;
      excludeSuperadmins?: boolean;
    }): Promise<UserRecord[]> {
      return listPostgresUsers(db, input);
    },
    async createUser(input: CreateUserInput): Promise<UserRecord> {
      return createPostgresUser(db, input);
    },
    async updateUser(input: UpdateUserInput): Promise<UserRecord> {
      return updatePostgresUser(db, input);
    },
    async markUserDeletionRequested(input: DeleteUserInput): Promise<boolean> {
      return markPostgresUserDeletionRequested(db, input);
    },
    async deleteUser(input: DeleteUserInput): Promise<UserRecord> {
      return deletePostgresUser(db, input);
    },
    async upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord> {
      return upsertPostgresUserIdentity(db, input);
    },
    async deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord> {
      return deletePostgresUserIdentity(db, input);
    },
    async getUserModelPreference(
      input: UserModelPreferenceInput
    ): Promise<UserModelPreference | undefined> {
      return getPostgresUserModelPreference(db, input);
    },
    async setUserModelPreference(
      input: UserModelPreferenceInput & { preference: UserModelPreference }
    ): Promise<void> {
      return setPostgresUserModelPreference(db, input);
    }
  };
}
