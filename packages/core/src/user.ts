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
  correlationId?: string;
  linkByVerifiedEmail?: boolean;
}

export interface CreateUserInput {
  clientInstanceId: ClientInstanceId;
  displayLabel: string;
  email?: string;
  roles?: UserRole[];
  permissionRefs?: string[];
  status?: UserStatus;
}

export interface UpdateUserInput {
  clientInstanceId: ClientInstanceId;
  userId: UserId;
  displayLabel?: string;
  email?: string | null;
  roles?: UserRole[];
  permissionRefs?: string[];
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

export interface UserStore {
  resolveUserIdentity(input: ResolveUserIdentityInput): Promise<AuthenticatedUser>;
  listUsers(input: { clientInstanceId: ClientInstanceId }): Promise<UserRecord[]>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  updateUser(input: UpdateUserInput): Promise<UserRecord>;
  upsertUserIdentity(input: UpsertUserIdentityInput): Promise<UserRecord>;
  deleteUserIdentity(input: DeleteUserIdentityInput): Promise<UserRecord>;
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

  return {
    id: input.user.id,
    externalUserId: input.identity.externalUserId,
    displayLabel: input.user.displayLabel,
    email: input.user.email,
    roles: input.user.roles,
    permissionRefs: input.user.permissionRefs,
    clientInstanceId: input.user.clientInstanceId,
    authSource: input.identity.authSource,
    correlationId: input.correlationId
  };
}
