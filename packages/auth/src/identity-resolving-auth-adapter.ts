import {
  createUserPrincipal,
  isAuthenticatedServicePrincipal,
  normalizeAuthenticatedUser,
  type AuthenticatedIdentity,
  type UserStore
} from "@work-shape/catalyst-core";
import type { AuthAdapter, AuthRequest } from "./types";

export interface IdentityResolvingAuthAdapterOptions {
  linkByVerifiedEmail?: boolean;
}

export class IdentityResolvingAuthAdapter implements AuthAdapter {
  readonly id: string;
  readonly credentialMode: AuthAdapter["credentialMode"];

  constructor(
    private readonly adapter: AuthAdapter,
    private readonly userStore: UserStore,
    private readonly options: IdentityResolvingAuthAdapterOptions = {}
  ) {
    this.id = `${adapter.id}:identity-resolved`;
    this.credentialMode = adapter.credentialMode;
  }

  async authenticate(request: AuthRequest): Promise<AuthenticatedIdentity> {
    const claims = await this.adapter.authenticate(request);
    // A personal API key's owner was read from the store by the key: no sign-in names them.
    if (isAuthenticatedServicePrincipal(claims) || claims.delegatedActor?.kind === "api_key") {
      return claims;
    }
    const resolved = await this.userStore.resolveUserIdentity({
      clientInstanceId: request.clientInstanceId,
      sourceUserId: claims.id,
      authSource: claims.authSource,
      externalUserId: claims.externalUserId,
      displayLabel: claims.displayLabel,
      email: claims.email,
      emailVerified: claims.emailVerified,
      groups: claims.groups,
      roles: claims.roles,
      permissionRefs: claims.permissionRefs,
      permissions: claims.permissions ?? [],
      correlationId: claims.correlationId ?? request.correlationId,
      linkByVerifiedEmail: this.options.linkByVerifiedEmail
    });
    return normalizeAuthenticatedUser({
      ...resolved,
      authenticationMethod: claims.authenticationMethod,
      ...(claims.sessionId === undefined ? {} : { sessionId: claims.sessionId }),
      subjectUserId: resolved.id,
      principal:
        claims.principal?.kind === "service"
          ? claims.principal
          : createUserPrincipal({
              ...resolved,
              subjectUserId: resolved.id
            }),
      delegatedActor: claims.delegatedActor,
      scopes: claims.scopes,
      ...(claims.twoFactor === undefined ? {} : { twoFactor: claims.twoFactor })
    });
  }
}
