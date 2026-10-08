import type { AuthenticatedIdentity, ClientInstanceId } from "@vivd-catalyst/core";

export type AuthRequestHeaders = Record<string, string | string[] | undefined>;

export interface AuthRequest {
  headers: AuthRequestHeaders;
  clientInstanceId: ClientInstanceId;
  correlationId: string;
}

export interface AuthAdapter {
  readonly id: string;
  /** Only explicit adapters may run when an explicit credential header is present. */
  readonly credentialMode: "ambient" | "explicit";
  authenticate(request: AuthRequest): Promise<AuthenticatedIdentity>;
}
