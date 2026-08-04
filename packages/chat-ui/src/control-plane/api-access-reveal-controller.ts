export interface RevealedApiCredential {
  secret: string;
  credentialName: string;
  serverUrl: string;
  authorityKey: string;
}

export interface ApiAccessRevealController {
  captureAuthority(): { authorityKey: string; revision: number } | undefined;
  updateAuthority(authorityKey: string | undefined): boolean;
  accept(
    originAuthority: { authorityKey: string; revision: number } | undefined,
    credential: Omit<RevealedApiCredential, "authorityKey">
  ): RevealedApiCredential | undefined;
}

export function createApiAccessRevealController(
  initialAuthorityKey: string | undefined
): ApiAccessRevealController {
  let currentAuthorityKey = initialAuthorityKey;
  let authorityRevision = 0;

  return {
    captureAuthority: () =>
      currentAuthorityKey
        ? { authorityKey: currentAuthorityKey, revision: authorityRevision }
        : undefined,
    updateAuthority(authorityKey) {
      if (currentAuthorityKey === authorityKey) {
        return false;
      }
      currentAuthorityKey = authorityKey;
      authorityRevision += 1;
      return true;
    },
    accept(originAuthority, credential) {
      if (
        !originAuthority ||
        currentAuthorityKey !== originAuthority.authorityKey ||
        authorityRevision !== originAuthority.revision
      ) {
        return undefined;
      }
      return { ...credential, authorityKey: originAuthority.authorityKey };
    }
  };
}

export function createApiAccessAuthorityKey(input: {
  apiBaseUrl: string;
  principalId: string | undefined;
  canManageSuperadminAccess: boolean;
}): string | undefined {
  if (!input.canManageSuperadminAccess || !input.principalId) {
    return undefined;
  }
  return JSON.stringify([input.apiBaseUrl, input.principalId, "superadmin"]);
}
