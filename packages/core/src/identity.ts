import type { ClientInstanceId } from "./ids";

export type UserRole = "user" | "admin" | "superadmin" | string;

export interface AuthenticatedUser {
  id: string;
  externalUserId: string;
  displayLabel: string;
  email?: string;
  emailVerified?: boolean;
  roles: UserRole[];
  permissionRefs: string[];
  clientInstanceId: ClientInstanceId;
  authSource: string;
  correlationId?: string;
}

export interface RuntimeCallContext {
  user: AuthenticatedUser;
  clientInstanceId: ClientInstanceId;
  correlationId: string;
  deadline?: Date;
  signal?: AbortSignal;
}
