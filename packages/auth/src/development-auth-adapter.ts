import { AppError, type AuthenticatedUser } from "@vivd-catalyst/core";
import type { AuthAdapter, AuthRequest } from "./types";

export const DEVELOPMENT_AUTH_USER_HEADER = "x-dev-user-id";

export interface DevelopmentAuthUser {
  id: string;
  externalUserId: string;
  displayLabel: string;
  email?: string;
  emailVerified?: boolean;
  roles: string[];
  permissionRefs: string[];
  authSource?: string;
}

export interface DevelopmentAuthAdapterOptions {
  enabled: boolean;
  user?: DevelopmentAuthUser;
  users?: DevelopmentAuthUser[];
  defaultUserId?: string;
}

export class DevelopmentAuthAdapter implements AuthAdapter {
  readonly id = "development";
  private readonly enabled: boolean;
  private readonly usersById: Map<string, DevelopmentAuthUser>;
  private readonly defaultUserId: string | undefined;

  constructor(options: DevelopmentAuthAdapterOptions) {
    const users = options.users && options.users.length > 0 ? options.users : options.user ? [options.user] : [];
    this.enabled = options.enabled;
    this.usersById = new Map(users.map((user) => [user.id, user]));
    this.defaultUserId = options.defaultUserId ?? users[0]?.id;

    if (users.length !== this.usersById.size) {
      throw new AppError("VALIDATION_FAILED", "Development auth users must have unique ids");
    }
    if (this.defaultUserId && !this.usersById.has(this.defaultUserId)) {
      throw new AppError("VALIDATION_FAILED", `Default development user '${this.defaultUserId}' is not configured`);
    }
  }

  async authenticate(request: AuthRequest): Promise<AuthenticatedUser> {
    if (!this.enabled) {
      throw new AppError("UNAUTHENTICATED", "Development auth is disabled");
    }

    const requestedUserId = readHeader(request.headers[DEVELOPMENT_AUTH_USER_HEADER]);
    const userId = requestedUserId ?? this.defaultUserId;
    const user = userId ? this.usersById.get(userId) : undefined;
    if (!user) {
      throw new AppError(
        "UNAUTHENTICATED",
        requestedUserId
          ? `Unknown development user '${requestedUserId}'`
          : "Development auth has no configured default user"
      );
    }

    return {
      ...user,
      authSource: user.authSource ?? this.id,
      clientInstanceId: request.clientInstanceId,
      correlationId: request.correlationId
    };
  }
}

function readHeader(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}
