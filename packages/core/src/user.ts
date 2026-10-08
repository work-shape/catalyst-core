import type { ReasoningEffortConfig } from "./config";
import { AppError } from "./errors";
import type { AuthenticatedUser, UserRole } from "./identity";
import type { ClientInstanceId, UserId } from "./ids";
import { createPlatformId } from "./ids";
import type { ISODateString } from "./time";

export type UserStatus = "active" | "disabled";

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
  status: UserStatus;
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
  listUsers(input: { clientInstanceId: ClientInstanceId }): Promise<UserRecord[]>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  updateUser(input: UpdateUserInput): Promise<UserRecord>;
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

export function authenticatedUserFromRecord(input: {
  user: UserRecord;
  identity: Pick<UserIdentity, "authSource" | "externalUserId">;
  correlationId?: string;
}): AuthenticatedUser {
  if (input.user.status !== "active") {
    throw new AppError("FORBIDDEN", "User is disabled");
  }

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
