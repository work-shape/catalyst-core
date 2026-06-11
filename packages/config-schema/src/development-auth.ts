import { AppError } from "@vivd-catalyst/core";
import type { ClientInstanceConfig, UserIdentityConfig } from "./schemas";

export interface DevelopmentAuthUsers {
  users: UserIdentityConfig[];
  defaultUserId: string;
}

export function getDevelopmentAuthUsers(config: ClientInstanceConfig): DevelopmentAuthUsers | undefined {
  const development = config.auth.development;
  if (!development?.enabled) {
    return undefined;
  }

  const users = development.users.length > 0 ? development.users : [development.user];
  if (users.length === 0) {
    throw new AppError("VALIDATION_FAILED", "Development auth is enabled without any configured users");
  }

  const seen = new Set<string>();
  const duplicateUser = users.find((user) => {
    if (seen.has(user.id)) {
      return true;
    }
    seen.add(user.id);
    return false;
  });
  if (duplicateUser) {
    throw new AppError("VALIDATION_FAILED", `Duplicate development user id '${duplicateUser.id}'`);
  }

  const defaultUserId = development.defaultUserId ?? users[0]?.id;
  if (!defaultUserId || !users.some((user) => user.id === defaultUserId)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Default development user '${String(defaultUserId)}' is not configured`
    );
  }

  return {
    users,
    defaultUserId
  };
}
