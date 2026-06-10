import type { UserStore } from "@agent-chat-platform/core";
import type { AuthAdapter, AuthRequest } from "./types";

export interface IdentityResolvingAuthAdapterOptions {
  linkByVerifiedEmail?: boolean;
}

export class IdentityResolvingAuthAdapter implements AuthAdapter {
  readonly id: string;

  constructor(
    private readonly adapter: AuthAdapter,
    private readonly userStore: UserStore,
    private readonly options: IdentityResolvingAuthAdapterOptions = {}
  ) {
    this.id = `${adapter.id}:identity-resolved`;
  }

  async authenticate(request: AuthRequest) {
    const claims = await this.adapter.authenticate(request);
    return this.userStore.resolveUserIdentity({
      clientInstanceId: request.clientInstanceId,
      sourceUserId: claims.id,
      authSource: claims.authSource,
      externalUserId: claims.externalUserId,
      displayLabel: claims.displayLabel,
      email: claims.email,
      emailVerified: claims.emailVerified,
      roles: claims.roles,
      permissionRefs: claims.permissionRefs,
      correlationId: claims.correlationId ?? request.correlationId,
      linkByVerifiedEmail: this.options.linkByVerifiedEmail
    });
  }
}
