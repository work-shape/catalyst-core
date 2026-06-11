import type { AuthenticatedUser, ClientInstanceId } from "@vivd-stage/core";

export type AuthRequestHeaders = Record<string, string | string[] | undefined>;

export interface AuthRequest {
  headers: AuthRequestHeaders;
  clientInstanceId: ClientInstanceId;
  correlationId: string;
}

export interface AuthAdapter {
  readonly id: string;
  authenticate(request: AuthRequest): Promise<AuthenticatedUser>;
}
