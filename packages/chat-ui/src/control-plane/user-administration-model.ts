import type {
  AdministeredUser,
  AdministeredUserIdentity,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, type Permission } from "@vivd-catalyst/core";
import type { TranslationKey } from "../i18n";

/** Auth source id of the standalone Better Auth adapter; only those identities have passwords. */
export const STANDALONE_AUTH_SOURCE = "better-auth";

export interface UserFormState {
  displayLabel: string;
  email: string;
  accessLevel: AccessLevel;
  permissionRefs: string;
  status: AdministeredUser["status"];
}

export interface CreateUserFormState extends UserFormState {
  /** Email a set-password link instead of choosing an initial password. */
  sendInvitation: boolean;
  createPasswordSignIn: boolean;
  password: string;
}

export interface IdentityFormState {
  authSource: string;
  externalUserId: string;
  displayLabel: string;
  email: string;
  emailVerified: boolean;
}

export type FormNoticeState = { kind: "success" | "error"; text: string } | undefined;

export type AccessLevel = "user" | "admin" | "superadmin";

export const ACCESS_LEVEL_OPTIONS: Array<{
  value: AccessLevel;
  label: string;
  description: string;
}> = [
  {
    value: "user",
    label: "User",
    description: "Can use chat and assigned capabilities."
  },
  {
    value: "admin",
    label: "Admin",
    description: "Can use chat and operational governance views."
  },
  {
    value: "superadmin",
    label: "Superadmin",
    description: "Can manage users, audit, and sensitive governance."
  }
];

export const emptyUserForm: UserFormState = {
  displayLabel: "",
  email: "",
  accessLevel: "user",
  permissionRefs: "",
  status: "active"
};

export function createEmptyCreateUserForm(invitationsEnabled = false): CreateUserFormState {
  return {
    ...emptyUserForm,
    sendInvitation: invitationsEnabled,
    createPasswordSignIn: !invitationsEnabled,
    password: generatePassword()
  };
}

export const emptyIdentityForm: IdentityFormState = {
  authSource: "session-token",
  externalUserId: "",
  displayLabel: "",
  email: "",
  emailVerified: false
};

export type UserStatusFilter = "all" | AdministeredUser["status"];

export const DEFAULT_ROWS_PER_PAGE = 10;

const ROLE_ORDER = ["superadmin", "admin", "user"];

export function filterUsers(
  users: AdministeredUser[],
  filters: {
    search: string;
    statusFilter: UserStatusFilter;
    roleFilter: string;
  }
): AdministeredUser[] {
  const query = filters.search.trim().toLowerCase();
  return users.filter((user) => {
    if (
      query &&
      ![user.displayLabel, user.email ?? "", ...user.roles].join(" ").toLowerCase().includes(query)
    ) {
      return false;
    }
    if (filters.statusFilter !== "all" && user.status !== filters.statusFilter) {
      return false;
    }
    if (filters.roleFilter !== "all" && !user.roles.includes(filters.roleFilter)) {
      return false;
    }
    return true;
  });
}

export function roleFilterOptions(users: AdministeredUser[]): string[] {
  return [...new Set(users.flatMap((user) => user.roles))].sort((left, right) => {
    const leftIndex = ROLE_ORDER.indexOf(left);
    const rightIndex = ROLE_ORDER.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (
        (leftIndex === -1 ? ROLE_ORDER.length : leftIndex) -
        (rightIndex === -1 ? ROLE_ORDER.length : rightIndex)
      );
    }

    return left.localeCompare(right);
  });
}

export function distinctAuthSources(identities: AdministeredUserIdentity[]): string[] {
  return [...new Set(identities.map((identity) => identity.authSource))];
}

export function formatDateTime(value: string | undefined): string | undefined {
  return value ? new Date(value).toLocaleString() : undefined;
}

export function generatePassword(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed";
}

export function userToForm(user: AdministeredUser): UserFormState {
  return {
    displayLabel: user.displayLabel,
    email: user.email ?? "",
    accessLevel: rolesToAccessLevel(user.roles),
    permissionRefs: formatList(user.permissionRefs),
    status: user.status
  };
}

export function formToCreateInput(form: CreateUserFormState): CreateAdministeredUserRequest {
  return {
    displayLabel: form.displayLabel.trim(),
    email: optionalText(form.email),
    roles: accessLevelToRoles(form.accessLevel),
    permissionRefs: parseList(form.permissionRefs),
    status: form.status,
    passwordSignIn:
      form.createPasswordSignIn && !form.sendInvitation ? { password: form.password } : undefined
  };
}

export function formToUpdateInput(form: UserFormState): UpdateAdministeredUserRequest {
  return {
    displayLabel: form.displayLabel.trim(),
    email: form.email.trim() ? form.email.trim() : null,
    roles: accessLevelToRoles(form.accessLevel),
    permissionRefs: parseList(form.permissionRefs),
    status: form.status
  };
}

export function formToIdentityInput(
  form: IdentityFormState
): UpsertAdministeredUserIdentityRequest {
  return {
    authSource: form.authSource.trim(),
    externalUserId: form.externalUserId.trim(),
    displayLabel: optionalText(form.displayLabel),
    email: optionalText(form.email),
    emailVerified: form.emailVerified
  };
}

export function rolesToAccessLevel(roles: string[]): AccessLevel {
  if (roles.includes("superadmin")) {
    return "superadmin";
  }
  if (roles.includes("admin")) {
    return "admin";
  }
  return "user";
}

export function accessLevelToRoles(accessLevel: AccessLevel): string[] {
  if (accessLevel === "superadmin") {
    return ["user", "admin", "superadmin"];
  }
  if (accessLevel === "admin") {
    return ["user", "admin"];
  }
  return ["user"];
}

export function accessLevelLabel(accessLevel: AccessLevel): string {
  return ACCESS_LEVEL_OPTIONS.find((option) => option.value === accessLevel)?.label ?? "User";
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatList(value: string[]): string {
  return value.join(", ");
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The typed permissions an administrator can give to or take from a user.
 * `config_assets.release` is left out: it is carried by service tokens for
 * release automation and the server refuses it on users.
 */
export const USER_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => permission !== "config_assets.release"
);

/** Where a user's permission state comes from; "none" is neither held nor touched. */
export type UserPermissionSource = "role" | "granted" | "revoked" | "none";

export interface UserPermissionState {
  permission: Permission;
  held: boolean;
  source: UserPermissionSource;
}

type PermissionSubject = Pick<AdministeredUser, "roles" | "permissions">;

/**
 * Mirrors `resolveEffectivePermissions` in core, but keeps the reason: role
 * defaults, plus individual grants, minus `!permission` revocations, which win.
 */
export function userPermissionStates(user: PermissionSubject): UserPermissionState[] {
  return USER_PERMISSIONS.map((permission) => {
    const source = userPermissionSource(user, permission);
    return { permission, held: source === "role" || source === "granted", source };
  });
}

/**
 * The `permissions` entries to store so that `permission` ends up held or not.
 * Granting removes a revocation and adds the name only when no role provides
 * it; taking away removes an individual grant and revokes a role default.
 * Entries for other permissions are kept as they are.
 */
export function setUserPermission(
  user: PermissionSubject,
  permission: Permission,
  held: boolean
): string[] {
  const roleDefault = isRoleDefaultPermission(user.roles, permission);
  const revocation = `!${permission}`;
  if (held) {
    const entries = user.permissions.filter((entry) => entry !== revocation);
    return roleDefault || entries.includes(permission) ? entries : [...entries, permission];
  }
  const entries = user.permissions.filter((entry) => entry !== permission && entry !== revocation);
  return roleDefault ? [...entries, revocation] : entries;
}

export const USER_PERMISSION_SOURCE_LABEL_KEYS: Record<
  Exclude<UserPermissionSource, "none">,
  TranslationKey
> = {
  role: "userRightSourceRole",
  granted: "userRightSourceGranted",
  revoked: "userRightSourceRevoked"
};

const USER_PERMISSION_COPY: Record<string, { label: TranslationKey; description: TranslationKey }> =
  {
    "agent_skills.approve": {
      label: "userRightAgentSkillsApprove",
      description: "userRightAgentSkillsApproveDescription"
    },
    "config_assets.read": {
      label: "userRightConfigAssetsRead",
      description: "userRightConfigAssetsReadDescription"
    },
    "config_assets.write": {
      label: "userRightConfigAssetsWrite",
      description: "userRightConfigAssetsWriteDescription"
    },
    "usage.view": { label: "userRightUsageView", description: "userRightUsageViewDescription" },
    "users.manage": {
      label: "userRightUsersManage",
      description: "userRightUsersManageDescription"
    },
    "api_access.manage": {
      label: "userRightApiAccessManage",
      description: "userRightApiAccessManageDescription"
    },
    "agent_models.manage": {
      label: "userRightAgentModelsManage",
      description: "userRightAgentModelsManageDescription"
    },
    "audit.view": { label: "userRightAuditView", description: "userRightAuditViewDescription" }
  };

/** Absent for a permission added to the catalog before it got its copy here. */
export function userPermissionCopy(
  permission: Permission
): { label: TranslationKey; description: TranslationKey } | undefined {
  return Object.hasOwn(USER_PERMISSION_COPY, permission)
    ? USER_PERMISSION_COPY[permission]
    : undefined;
}

function userPermissionSource(
  user: PermissionSubject,
  permission: Permission
): UserPermissionSource {
  if (user.permissions.includes(`!${permission}`)) {
    return "revoked";
  }
  if (isRoleDefaultPermission(user.roles, permission)) {
    return "role";
  }
  return user.permissions.includes(permission) ? "granted" : "none";
}

function isRoleDefaultPermission(roles: string[], permission: Permission): boolean {
  return roles.some(
    (role) => isDefaultPermissionRole(role) && ROLE_DEFAULT_PERMISSIONS[role].includes(permission)
  );
}

function isDefaultPermissionRole(role: string): role is keyof typeof ROLE_DEFAULT_PERMISSIONS {
  return Object.hasOwn(ROLE_DEFAULT_PERMISSIONS, role);
}
