import { AppError, type AuthenticatedIdentity } from "@vivd-catalyst/core";
import { hasExplicitCredentials } from "./explicit-credentials";
import type { AuthAdapter, AuthRequest } from "./types";

export class CompositeAuthAdapter implements AuthAdapter {
  readonly id = "composite";
  // Safe to nest: explicit requests only reach explicit child adapters.
  readonly credentialMode = "explicit";
  private readonly adapters: AuthAdapter[];

  constructor(adapters: AuthAdapter[]) {
    this.adapters = adapters;
  }

  async authenticate(request: AuthRequest): Promise<AuthenticatedIdentity> {
    const failures: string[] = [];
    const explicitCredentials = hasExplicitCredentials(request.headers);
    for (const adapter of this.adapters) {
      if (explicitCredentials && adapter.credentialMode !== "explicit") {
        continue;
      }
      try {
        return await adapter.authenticate(request);
      } catch (error) {
        if (error instanceof AppError && error.code === "UNAUTHENTICATED") {
          failures.push(`${adapter.id}: ${error.message}`);
          continue;
        }
        throw error;
      }
    }

    throw new AppError("UNAUTHENTICATED", "No auth adapter accepted the request", {
      failures
    });
  }
}
