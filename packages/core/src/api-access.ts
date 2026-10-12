import { AppError } from "./errors";
import type { ApiCredentialId, ClientInstanceId, ServicePrincipalId, UserId } from "./ids";
import { asApiCredentialId, createPlatformId } from "./ids";
import type { ISODateString } from "./time";

export type ServicePrincipalStatus = "active" | "disabled";

/** What a principal's name looks like: a slug, as an asset's name is. */
export const SERVICE_PRINCIPAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** The name a principal gets from its label where none is given: the label as a slug. */
export function servicePrincipalNameFromLabel(displayLabel: string): string {
  const slug = displayLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug === "" ? "principal" : slug;
}

export interface ServicePrincipalRecord {
  id: ServicePrincipalId;
  clientInstanceId: ClientInstanceId;
  /**
   * What a definition names the principal by, such as the `runAs` of a Workflow. A slug,
   * unique on the instance, set when the principal is created and never changed: a definition
   * moves between instances unchanged, which the id and the label of a principal do not allow.
   */
  name: string;
  displayLabel: string;
  description?: string;
  status: ServicePrincipalStatus;
  permissionRefs: string[];
  permissions: string[];
  createdByUserId?: UserId;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  lastUsedAt?: ISODateString;
}

export interface ApiCredentialRecord {
  id: ApiCredentialId;
  clientInstanceId: ClientInstanceId;
  servicePrincipalId: ServicePrincipalId;
  name: string;
  keyPrefix: string;
  /** An absent restriction means the credential inherits all principal permissions. */
  scopes?: string[];
  createdAt: ISODateString;
  expiresAt?: ISODateString;
  revokedAt?: ISODateString;
  lastUsedAt?: ISODateString;
}

export interface ResolvedApiCredential {
  credential: ApiCredentialRecord;
  servicePrincipal: ServicePrincipalRecord;
  /** Auth-only verification material. Never expose this through management APIs. */
  secretHash: string;
}

export interface CreateServicePrincipalInput {
  clientInstanceId: ClientInstanceId;
  /**
   * A name another principal of the instance has is refused with `CONFLICT`. Left out, the
   * name is the label as a slug, with a short suffix where that is taken.
   */
  name?: string;
  displayLabel: string;
  description?: string;
  status?: ServicePrincipalStatus;
  permissionRefs?: string[];
  permissions?: string[];
  createdByUserId?: UserId;
}

export interface UpdateServicePrincipalInput {
  clientInstanceId: ClientInstanceId;
  servicePrincipalId: ServicePrincipalId;
  displayLabel?: string;
  description?: string | null;
  status?: ServicePrincipalStatus;
  permissionRefs?: string[];
  permissions?: string[];
}

export interface CreateApiCredentialInput {
  clientInstanceId: ClientInstanceId;
  servicePrincipalId: ServicePrincipalId;
  name: string;
  scopes?: string[];
  expiresAt?: ISODateString;
}

export interface CreatedApiCredential {
  credential: ApiCredentialRecord;
  /** Returned once at creation. Only its SHA-256 hash is persisted. */
  secret: string;
}

export interface ApiAccessStore {
  listServicePrincipals(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<ServicePrincipalRecord[]>;
  /** The principal of that name, active or not. A name is one principal's for good. */
  findServicePrincipalByName(input: {
    clientInstanceId: ClientInstanceId;
    name: string;
  }): Promise<ServicePrincipalRecord | undefined>;
  createServicePrincipal(input: CreateServicePrincipalInput): Promise<ServicePrincipalRecord>;
  updateServicePrincipal(input: UpdateServicePrincipalInput): Promise<ServicePrincipalRecord>;
  /**
   * Removes the principal with its keys and with every grant row it holds, in one
   * transaction: a row left behind would answer for whoever carried the id next. Answers
   * nothing for a principal the instance does not have.
   */
  deleteServicePrincipal(input: {
    clientInstanceId: ClientInstanceId;
    servicePrincipalId: ServicePrincipalId;
  }): Promise<ServicePrincipalRecord | undefined>;
  listApiCredentials(input: {
    clientInstanceId: ClientInstanceId;
    servicePrincipalId: ServicePrincipalId;
  }): Promise<ApiCredentialRecord[]>;
  createApiCredential(input: CreateApiCredentialInput): Promise<CreatedApiCredential>;
  revokeApiCredential(input: {
    clientInstanceId: ClientInstanceId;
    credentialId: ApiCredentialId;
  }): Promise<ApiCredentialRecord>;
  resolveApiCredential(input: {
    clientInstanceId: ClientInstanceId;
    credentialId: ApiCredentialId;
  }): Promise<ResolvedApiCredential | undefined>;
  updateApiCredentialLastUsed(input: {
    clientInstanceId: ClientInstanceId;
    credentialId: ApiCredentialId;
    usedAt?: ISODateString;
  }): Promise<ApiCredentialRecord>;
}

const API_CREDENTIAL_PREFIX = "cat";
const API_CREDENTIAL_RANDOM_BYTES = 32;

export function createServicePrincipalId(): ServicePrincipalId {
  return createPlatformId<"ServicePrincipalId">("spn");
}

export function createApiCredentialId(): ApiCredentialId {
  return createPlatformId<"ApiCredentialId">("apic");
}

export async function createApiCredentialSecretMaterial(
  credentialId: ApiCredentialId
): Promise<{ secret: string; secretHash: string; keyPrefix: string }> {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues || !crypto.subtle) {
    throw new AppError("INTERNAL", "Secure credential generation is unavailable");
  }

  const random = new Uint8Array(API_CREDENTIAL_RANDOM_BYTES);
  crypto.getRandomValues(random);
  const keyPrefix = `${API_CREDENTIAL_PREFIX}.${credentialId}.`;
  const secret = `${keyPrefix}${bytesToHex(random)}`;
  return {
    secret,
    secretHash: await hashApiCredentialSecret(secret),
    keyPrefix
  };
}

export async function hashApiCredentialSecret(secret: string): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new AppError("INTERNAL", "Secure credential hashing is unavailable");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return bytesToHex(new Uint8Array(digest));
}

export function parseApiCredentialSecret(secret: string): ApiCredentialId | undefined {
  const segments = secret.split(".");
  if (
    segments.length !== 3 ||
    segments[0] !== API_CREDENTIAL_PREFIX ||
    !segments[1]?.startsWith("apic_") ||
    !segments[2] ||
    !/^[0-9a-f]{64}$/.test(segments[2])
  ) {
    return undefined;
  }
  return asApiCredentialId(segments[1]);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
