import { AppError } from "./errors";
import type { ClientInstanceId } from "./ids";
import type { LocaleCode } from "./localization";

export type UserRole = "user" | "admin" | "superadmin" | string;

export const AUTH_SCOPE_WILDCARD = "*" as const;

export const CHAT_SESSION_AUTH_SCOPES = [
  "me:read",
  "me:delete",
  "config:read",
  "conversation:read",
  "conversation:write",
  "run:start",
  "run:observe",
  "run:cancel",
  "run:command"
] as const;

export const FIRST_PARTY_AUTH_SCOPES = [
  AUTH_SCOPE_WILDCARD,
  ...CHAT_SESSION_AUTH_SCOPES,
  "me:write",
  "governance:read",
  "governance:write",
  "user_admin:read",
  "user_admin:write",
  "config_assets:read",
  "config_assets:write",
  "config_assets:release"
] as const;

export type ChatSessionAuthScope = (typeof CHAT_SESSION_AUTH_SCOPES)[number];
export type FirstPartyAuthScope = (typeof FIRST_PARTY_AUTH_SCOPES)[number];
export type AuthScope = FirstPartyAuthScope | (string & {});

export type AuthPrincipalKind = "user" | "service";

export interface AuthPrincipal {
  kind: AuthPrincipalKind;
  id: string;
  displayLabel: string;
  clientInstanceId: ClientInstanceId;
  authSource: string;
  externalUserId?: string;
}

export interface DelegatedActor {
  kind: "service_principal";
  id: string;
  displayLabel?: string;
  authSource: string;
}

export interface AuthenticatedUser {
  id: string;
  externalUserId: string;
  displayLabel: string;
  email?: string;
  emailVerified?: boolean;
  roles: UserRole[];
  permissionRefs: string[];
  permissions?: string[];
  clientInstanceId: ClientInstanceId;
  authSource: string;
  correlationId?: string;
  principal?: AuthPrincipal;
  subjectUserId?: string;
  delegatedActor?: DelegatedActor;
  scopes?: AuthScope[];
}

export interface RuntimeCallContext {
  user: AuthenticatedUser;
  clientInstanceId: ClientInstanceId;
  correlationId: string;
  locale?: LocaleCode;
  principal?: AuthPrincipal;
  subjectUserId?: string;
  delegatedActor?: DelegatedActor;
  scopes?: AuthScope[];
  deadline?: Date;
  signal?: AbortSignal;
}

export function createUserPrincipal(user: AuthenticatedUser): AuthPrincipal {
  return {
    kind: "user",
    id: user.id,
    externalUserId: user.externalUserId,
    displayLabel: user.displayLabel,
    clientInstanceId: user.clientInstanceId,
    authSource: user.authSource
  };
}

export function normalizeAuthenticatedUser(user: AuthenticatedUser): AuthenticatedUser {
  const subjectUserId = user.subjectUserId ?? user.id;
  const principal =
    user.principal?.kind === "service"
      ? user.principal
      : createUserPrincipal({
          ...user,
          id: subjectUserId
        });

  return {
    ...user,
    subjectUserId,
    principal,
    scopes: user.scopes
  };
}

export function authContextFromUser(user: AuthenticatedUser): Pick<
  RuntimeCallContext,
  "principal" | "subjectUserId" | "delegatedActor" | "scopes"
> {
  const normalized = normalizeAuthenticatedUser(user);
  return {
    principal: normalized.principal,
    subjectUserId: normalized.subjectUserId,
    delegatedActor: normalized.delegatedActor,
    scopes: normalized.scopes
  };
}

export function getSubjectUserId(user: AuthenticatedUser): string {
  return user.subjectUserId ?? user.id;
}

export function getRuntimeSubjectUserId(context: RuntimeCallContext): string {
  return context.subjectUserId ?? getSubjectUserId(context.user);
}

export function getAuthPrincipal(user: AuthenticatedUser): AuthPrincipal {
  return normalizeAuthenticatedUser(user).principal ?? createUserPrincipal(user);
}

export function getAuthScopes(user: Pick<AuthenticatedUser, "scopes">): AuthScope[] {
  return user.scopes ?? [AUTH_SCOPE_WILDCARD];
}

export function hasAuthScope(user: Pick<AuthenticatedUser, "scopes">, scope: AuthScope): boolean {
  const scopes = getAuthScopes(user);
  return scopes.includes(AUTH_SCOPE_WILDCARD) || scopes.includes(scope);
}

export function requireAuthScope(user: Pick<AuthenticatedUser, "scopes">, scope: AuthScope): void {
  if (!hasAuthScope(user, scope)) {
    throw new AppError("FORBIDDEN", `Missing auth scope '${scope}'`);
  }
}

export function isChatSessionAuthScope(scope: string): scope is ChatSessionAuthScope {
  return CHAT_SESSION_AUTH_SCOPES.includes(scope as ChatSessionAuthScope);
}
