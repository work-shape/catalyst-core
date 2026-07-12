import type {
  AuthenticatedIdentity,
  ClientInstanceId
} from "@vivd-catalyst/core";

export type AuthRequestHeaders = Record<string, string | string[] | undefined>;

export interface AuthRequest {
  headers: AuthRequestHeaders;
  clientInstanceId: ClientInstanceId;
  correlationId: string;
}

export interface AuthAdapter {
  readonly id: string;
  authenticate(request: AuthRequest): Promise<AuthenticatedIdentity>;
}
