import {
  AppError,
  createApiCredentialId,
  createApiCredentialSecretMaterial,
  createServicePrincipalId,
  type ApiAccessStore,
  type ApiCredentialRecord,
  type CreateApiCredentialInput,
  type CreatedApiCredential,
  type CreateServicePrincipalInput,
  type ResolvedApiCredential,
  type ServicePrincipalRecord,
  type UpdateServicePrincipalInput
} from "./index";

interface StoredApiCredential extends ApiCredentialRecord {
  secretHash: string;
}

export interface InMemoryApiAccessStoreOptions {
  isUserInClient: (input: {
    clientInstanceId: ServicePrincipalRecord["clientInstanceId"];
    userId: NonNullable<ServicePrincipalRecord["createdByUserId"]>;
  }) => boolean | Promise<boolean>;
}

export class InMemoryApiAccessStore implements ApiAccessStore {
  private readonly servicePrincipals = new Map<string, ServicePrincipalRecord>();
  private readonly apiCredentials = new Map<string, StoredApiCredential>();

  constructor(private readonly options: InMemoryApiAccessStoreOptions) {}

  async listServicePrincipals(input: {
    clientInstanceId: ServicePrincipalRecord["clientInstanceId"];
  }): Promise<ServicePrincipalRecord[]> {
    return [...this.servicePrincipals.values()]
      .filter((principal) => principal.clientInstanceId === input.clientInstanceId)
      .sort((left, right) => left.displayLabel.localeCompare(right.displayLabel));
  }

  async createServicePrincipal(
    input: CreateServicePrincipalInput
  ): Promise<ServicePrincipalRecord> {
    if (
      input.createdByUserId &&
      !(await this.options.isUserInClient({
        clientInstanceId: input.clientInstanceId,
        userId: input.createdByUserId
      }))
    ) {
      throw new AppError("NOT_FOUND", "Creator user is not available");
    }
    const now = new Date().toISOString();
    const principal: ServicePrincipalRecord = {
      id: createServicePrincipalId(),
      clientInstanceId: input.clientInstanceId,
      displayLabel: input.displayLabel,
      description: input.description,
      status: input.status ?? "active",
      permissionRefs: input.permissionRefs ?? [],
      permissions: input.permissions ?? [],
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now
    };
    this.servicePrincipals.set(principal.id, principal);
    return principal;
  }

  async updateServicePrincipal(
    input: UpdateServicePrincipalInput
  ): Promise<ServicePrincipalRecord> {
    const principal = this.requireServicePrincipal(input);
    const updated: ServicePrincipalRecord = {
      ...principal,
      displayLabel: input.displayLabel ?? principal.displayLabel,
      description:
        input.description === undefined ? principal.description : (input.description ?? undefined),
      status: input.status ?? principal.status,
      permissionRefs: input.permissionRefs ?? principal.permissionRefs,
      permissions: input.permissions ?? principal.permissions,
      updatedAt: new Date().toISOString()
    };
    this.servicePrincipals.set(updated.id, updated);
    return updated;
  }

  async listApiCredentials(input: {
    clientInstanceId: ApiCredentialRecord["clientInstanceId"];
    servicePrincipalId: ApiCredentialRecord["servicePrincipalId"];
  }): Promise<ApiCredentialRecord[]> {
    this.requireServicePrincipal(input);
    return [...this.apiCredentials.values()]
      .filter(
        (credential) =>
          credential.clientInstanceId === input.clientInstanceId &&
          credential.servicePrincipalId === input.servicePrincipalId
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(publicCredential);
  }

  async createApiCredential(input: CreateApiCredentialInput): Promise<CreatedApiCredential> {
    this.requireServicePrincipal(input);
    const id = createApiCredentialId();
    const material = await createApiCredentialSecretMaterial(id);
    const credential: StoredApiCredential = {
      id,
      clientInstanceId: input.clientInstanceId,
      servicePrincipalId: input.servicePrincipalId,
      name: input.name,
      keyPrefix: material.keyPrefix,
      scopes: input.scopes,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      secretHash: material.secretHash
    };
    this.apiCredentials.set(id, credential);
    return { credential: publicCredential(credential), secret: material.secret };
  }

  async revokeApiCredential(
    input: Parameters<ApiAccessStore["revokeApiCredential"]>[0]
  ): Promise<ApiCredentialRecord> {
    const credential = this.requireApiCredential(input);
    if (credential.revokedAt) {
      return publicCredential(credential);
    }
    const revoked: StoredApiCredential = {
      ...credential,
      revokedAt: new Date().toISOString()
    };
    this.apiCredentials.set(revoked.id, revoked);
    return publicCredential(revoked);
  }

  async resolveApiCredential(
    input: Parameters<ApiAccessStore["resolveApiCredential"]>[0]
  ): Promise<ResolvedApiCredential | undefined> {
    const credential = this.apiCredentials.get(input.credentialId);
    if (!credential || credential.clientInstanceId !== input.clientInstanceId) {
      return undefined;
    }
    const servicePrincipal = this.servicePrincipals.get(credential.servicePrincipalId);
    if (!servicePrincipal || servicePrincipal.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("INTERNAL", "API credential points to a missing service principal");
    }
    return {
      credential: publicCredential(credential),
      servicePrincipal,
      secretHash: credential.secretHash
    };
  }

  async updateApiCredentialLastUsed(
    input: Parameters<ApiAccessStore["updateApiCredentialLastUsed"]>[0]
  ): Promise<ApiCredentialRecord> {
    const credential = this.requireApiCredential(input);
    const principal = this.requireServicePrincipal({
      clientInstanceId: input.clientInstanceId,
      servicePrincipalId: credential.servicePrincipalId
    });
    const lastUsedAt = input.usedAt ?? new Date().toISOString();
    const credentialLastUsedAt = latestTimestamp(credential.lastUsedAt, lastUsedAt);
    const principalLastUsedAt = latestTimestamp(principal.lastUsedAt, lastUsedAt);
    const updatedCredential: StoredApiCredential = {
      ...credential,
      lastUsedAt: credentialLastUsedAt
    };
    this.apiCredentials.set(updatedCredential.id, updatedCredential);
    this.servicePrincipals.set(principal.id, {
      ...principal,
      lastUsedAt: principalLastUsedAt,
      updatedAt: principal.updatedAt
    });
    return publicCredential(updatedCredential);
  }

  private requireServicePrincipal(input: {
    clientInstanceId: ServicePrincipalRecord["clientInstanceId"];
    servicePrincipalId: ServicePrincipalRecord["id"];
  }): ServicePrincipalRecord {
    const principal = this.servicePrincipals.get(input.servicePrincipalId);
    if (!principal || principal.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "Service principal is not available");
    }
    return principal;
  }

  private requireApiCredential(input: {
    clientInstanceId: ApiCredentialRecord["clientInstanceId"];
    credentialId: ApiCredentialRecord["id"];
  }): StoredApiCredential {
    const credential = this.apiCredentials.get(input.credentialId);
    if (!credential || credential.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "API credential is not available");
    }
    return credential;
  }
}

function publicCredential(credential: StoredApiCredential): ApiCredentialRecord {
  const { secretHash: _, ...record } = credential;
  return record;
}

function latestTimestamp(current: string | undefined, candidate: string): string {
  return current && Date.parse(current) >= Date.parse(candidate) ? current : candidate;
}
