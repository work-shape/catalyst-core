import type { StorePage } from "./paging";
import type { ReasoningEffortConfig } from "./config";
import { AppError } from "./errors";
import type { AuthenticatedUser, UserRole } from "./identity";
import type { ClientInstanceId, UserId } from "./ids";
import { createPlatformId } from "./ids";
import type { ISODateString } from "./time";

/** What an administrator sets. */
export type UserStatus = "active" | "disabled";

/**
 * The status a user is read with. A user whose deletion was requested reads `deleting`,
 * whatever an administrator set before: the account is closed and its data is being removed.
 */
export type UserRecordStatus = UserStatus | "deleting";

export interface UserIdentity {
  clientInstanceId: ClientInstanceId;
  userId: UserId;
  authSource: string;
  externalUserId: string;
  displayLabel?: string;
  email?: string;
  emailVerified: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  lastAuthenticatedAt?: ISODateString;
}

export interface UserRecord {
  id: UserId;
  clientInstanceId: ClientInstanceId;
  displayLabel: string;
  email?: string;
  roles: UserRole[];
  permissionRefs: string[];
  permissions: string[];
  status: UserRecordStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  lastAuthenticatedAt?: ISODateString;
  identities: UserIdentity[];
}

export interface ResolveUserIdentityInput {
  clientInstanceId: ClientInstanceId;
  authSource: string;
  externalUserId: string;
  sourceUserId?: string;
  displayLabel: string;
  email?: string;
  emailVerified?: boolean;
  roles: UserRole[];
  permissionRefs: string[];
  permissions: string[];
  correlationId?: string;
  linkByVerifiedEmail?: boolean;
}

export interface CreateUserInput {
  clientInstanceId: ClientInstanceId;
  displayLabel: string;
  email?: string;
  roles?: UserRole[];
  permissionRefs?: string[];
  permissions?: string[];
  status?: UserStatus;
}

export interface UpdateUserInput {
  clientInstanceId: ClientInstanceId;
  userId: UserId;
  displayLabel?: string;
  email?: string | null;
  roles?: UserRole[];
  permissionRefs?: string[];
  permissions?: string[];
  status?: UserStatus;
}

export interface UpsertUserIdentityInput {
  clientInstanceId: ClientInstanceId;
  userId: UserId;
  authSource: string;
  externalUserId: string;
  displayLabel?: string;
  email?: string;
  emailVerified?: boolean;
}

export interface DeleteUserIdentityInput {
  clientInstanceId: ClientInstanceId;
  userId: UserId;
  authSource: string;
  externalUserId: string;
}

export interface DeleteUserInput {
  clientInstanceId: ClientInstanceId;
  userId: UserId;
}

/**
 * The model and the reasoning efforts a user last picked. A new conversation starts from them
 * where its agent offers them; without a pick it follows the configured defaults.
 */
export interface UserModelPreference {
  modelBindingId?: string;
  /** Effort picks by the binding id of the model each was made for. */
  reasoningEfforts: Record<string, ReasoningEffortConfig>;
}

export interface UserModelPreferenceInput {
  clientInstanceId: ClientInstanceId;
  userId: UserId;
}

export interface UserStore {
  resolveUserIdentity(input: ResolveUserIdentityInput): Promise<AuthenticatedUser>;
  listUsers(input: {
    clientInstanceId: ClientInstanceId;
    page?: StorePage;
    excludeSuperadmins?: boolean;
  }): Promise<UserRecord[]>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  /** Refuses with `userInDeletionError` when the deletion of the user was requested. */
  updateUser(input: UpdateUserInput): Promise<UserRecord>;
  /**
   * Marks the user as being deleted. From the commit on the user reads `deleting`: every
   * sign-in, session and token of theirs is refused. Resolves false when the mark was already
   * set. Nothing removes the mark; the row goes with `deleteUser`.
   */
  markUserDeletionRequested(input: DeleteUserInput): Promise<boolean>;
  deleteUser(input: DeleteUserInput): Promise<UserRecord>;
  upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord>;
  deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord>;
  getUserModelPreference(input: UserModelPreferenceInput): Promise<UserModelPreference | undefined>;
  setUserModelPreference(
    input: UserModelPreferenceInput & { preference: UserModelPreference }
  ): Promise<void>;
}

export function createUserId(): UserId {
  return createPlatformId<"UserId">("usr");
}

/**
 * Refuses a user who may not act. A user being deleted is answered like someone who is not
 * signed in, so the interface ends the session; a disabled user is told so.
 */
export function requireUsableUser(status: UserRecordStatus): void {
  if (status === "deleting") {
    throw new AppError("UNAUTHENTICATED", "User account is being deleted");
  }
  if (status !== "active") {
    throw new AppError("FORBIDDEN", "User is disabled");
  }
}

export function authenticatedUserFromRecord(input: {
  user: UserRecord;
  identity: Pick<UserIdentity, "authSource" | "externalUserId">;
  correlationId?: string;
}): AuthenticatedUser {
  requireUsableUser(input.user.status);

  const authenticatedUser: AuthenticatedUser = {
    id: input.user.id,
    externalUserId: input.identity.externalUserId,
    displayLabel: input.user.displayLabel,
    email: input.user.email,
    roles: input.user.roles,
    permissionRefs: input.user.permissionRefs,
    permissions: input.user.permissions,
    clientInstanceId: input.user.clientInstanceId,
    authSource: input.identity.authSource,
    correlationId: input.correlationId,
    subjectUserId: input.user.id
  };

  return {
    ...authenticatedUser,
    principal: {
      kind: "user",
      id: authenticatedUser.id,
      externalUserId: authenticatedUser.externalUserId,
      displayLabel: authenticatedUser.displayLabel,
      clientInstanceId: authenticatedUser.clientInstanceId,
      authSource: authenticatedUser.authSource
    }
  };
}

/**
 * The answer to a change of a user whose deletion was requested. The account is closed to
 * administration too: nothing of it is changed or given back while it is being removed.
 */
export function userInDeletionError(): AppError {
  return new AppError("CONFLICT", "User account is being deleted");
}
