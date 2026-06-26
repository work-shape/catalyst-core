import type {
  AdministeredUser,
  AdministeredUserIdentity,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";

/** Auth source id of the standalone Better Auth adapter; only those identities have passwords. */
export const STANDALONE_AUTH_SOURCE = "better-auth";

export interface UserFormState {
  displayLabel: string;
  email: string;
  roles: string;
  permissionRefs: string;
  status: AdministeredUser["status"];
}

export interface IdentityFormState {
  authSource: string;
  externalUserId: string;
  displayLabel: string;
  email: string;
  emailVerified: boolean;
}

export type FormNoticeState = { kind: "success" | "error"; text: string } | undefined;

export const emptyUserForm: UserFormState = {
  displayLabel: "",
  email: "",
  roles: "user",
  permissionRefs: "",
  status: "active"
};

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
    roles: formatList(user.roles),
    permissionRefs: formatList(user.permissionRefs),
    status: user.status
  };
}

export function formToCreateInput(form: UserFormState): CreateAdministeredUserRequest {
  return {
    displayLabel: form.displayLabel.trim(),
    email: optionalText(form.email),
    roles: parseList(form.roles),
    permissionRefs: parseList(form.permissionRefs),
    status: form.status
  };
}

export function formToUpdateInput(form: UserFormState): UpdateAdministeredUserRequest {
  return {
    displayLabel: form.displayLabel.trim(),
    email: form.email.trim() ? form.email.trim() : null,
    roles: parseList(form.roles),
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
