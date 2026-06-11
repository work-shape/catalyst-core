import { AppError, type AuthenticatedUser } from "@vivd-stage/core";
import type { AuthAdapter, AuthRequest } from "./types";

export class CompositeAuthAdapter implements AuthAdapter {
  readonly id = "composite";
  private readonly adapters: AuthAdapter[];

  constructor(adapters: AuthAdapter[]) {
    this.adapters = adapters;
  }

  async authenticate(request: AuthRequest): Promise<AuthenticatedUser> {
    const failures: string[] = [];
    for (const adapter of this.adapters) {
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
