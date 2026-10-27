import {
  ACTIONS,
  type OperationScope,
  type PlatformAction
} from "@work-shape/catalyst-asset-schemas";
import { createApiCredentialId, createApiCredentialSecretMaterial } from "./api-access";
import { AppError } from "./errors";
import type { ApiCredentialId, ClientInstanceId, UserId } from "./ids";
import { createPlatformId } from "./ids";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";

/**
 * A person's own API key. It is a credential, not a holder of rights: every call acts as its
 * owner with the owner's rights of that moment, narrowed to the key's scopes. It lives in the
 * table of service principal keys and has the same secret format, with a user as its owner.
 */
export interface PersonalApiKeyRecord {
  id: ApiCredentialId;
  clientInstanceId: ClientInstanceId;
  ownerUserId: UserId;
  /** The owner's name, as the list of every person's keys reads it. */
  ownerDisplayLabel?: string;
  name: string;
  keyPrefix: string;
  /** `<action>`, `<action>:<workspace id>` or `<action>:<workspace id>/<asset>`, one or more. */
  scopes: string[];
  createdAt: ISODateString;
  expiresAt: ISODateString;
  revokedAt?: ISODateString;
  lastUsedAt?: ISODateString;
}

export interface ResolvedPersonalApiKey {
  key: PersonalApiKeyRecord;
  /** Auth-only verification material. Never expose this through management APIs. */
  secretHash: string;
}

export interface CreatePersonalApiKeyInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: UserId;
  name: string;
  scopes: string[];
  expiresAt: ISODateString;
}

export interface CreatedPersonalApiKey {
  key: PersonalApiKeyRecord;
  /** Returned once at creation. Only its SHA-256 hash is persisted. */
  secret: string;
}

/**
 * What the CLI holds while a person confirms its connect code: the short code it shows and
 * the long one it collects the key with. Only their hashes are stored.
 */
export interface StartedConnectCode {
  userCode: string;
  deviceCode: string;
  expiresAt: ISODateString;
}

/** What a person reads of a connect code before confirming it. */
export interface ConnectCodeRecord {
  id: string;
  clientInstanceId: ClientInstanceId;
  /** What the CLI calls itself, such as the machine it runs on. Attribution, never authority. */
  clientLabel?: string;
  createdAt: ISODateString;
  expiresAt: ISODateString;
  approvedAt?: ISODateString;
}

/** The answer of one collection try of the CLI. */
export type ConnectCodeRedemption =
  | { status: "pending" }
  | { status: "issued"; created: CreatedPersonalApiKey }
  /** Unknown, expired, already collected, or of another instance: told apart for nobody. */
  | { status: "invalid" };

export interface PersonalApiKeyStore {
  /** The owner's keys, or every person's with no owner given, newest first. */
  listPersonalApiKeys(input: {
    clientInstanceId: ClientInstanceId;
    ownerUserId?: UserId;
    page?: StorePage;
  }): Promise<PersonalApiKeyRecord[]>;
  /** Refuses with `CONFLICT` when the owner holds `PERSONAL_API_KEYS_PER_USER_MAX` usable keys. */
  createPersonalApiKey(input: CreatePersonalApiKeyInput): Promise<CreatedPersonalApiKey>;
  /** Nothing for a key the instance, or the owner where one is given, does not have. */
  revokePersonalApiKey(input: {
    clientInstanceId: ClientInstanceId;
    keyId: ApiCredentialId;
    ownerUserId?: UserId;
  }): Promise<PersonalApiKeyRecord | undefined>;
  resolvePersonalApiKey(input: {
    clientInstanceId: ClientInstanceId;
    keyId: ApiCredentialId;
  }): Promise<ResolvedPersonalApiKey | undefined>;
  markPersonalApiKeyUsed(input: {
    clientInstanceId: ClientInstanceId;
    keyId: ApiCredentialId;
  }): Promise<void>;
  /** Stores a new code by the hashes of its two parts, and drops codes long expired. */
  startConnectCode(input: {
    clientInstanceId: ClientInstanceId;
    userCodeHash: string;
    deviceCodeHash: string;
    clientLabel?: string;
    expiresAt: ISODateString;
  }): Promise<void>;
  /** The unexpired code a person typed, approved or not. */
  findConnectCode(input: {
    clientInstanceId: ClientInstanceId;
    userCodeHash: string;
  }): Promise<ConnectCodeRecord | undefined>;
  /**
   * Fixes who the key will act as and what it will cover. Nothing for a code that is unknown,
   * expired or already approved: a code is confirmed once.
   */
  approveConnectCode(input: {
    clientInstanceId: ClientInstanceId;
    userCodeHash: string;
    ownerUserId: UserId;
    name: string;
    scopes: string[];
    keyExpiresAt: ISODateString;
  }): Promise<ConnectCodeRecord | undefined>;
  /**
   * Issues the key of an approved code and marks the code collected, in one transaction: two
   * tries at once yield one key.
   */
  redeemConnectCode(input: {
    clientInstanceId: ClientInstanceId;
    deviceCodeHash: string;
  }): Promise<ConnectCodeRedemption>;
}

/** How long a connect code waits for its confirmation and its collection. */
export const CONNECT_CODE_TTL_MS = 15 * 60 * 1000;
/** How often the CLI asks whether its code was confirmed. */
export const CONNECT_CODE_POLL_INTERVAL_MS = 3000;
/** The longest a personal key may live. A person who needs it longer issues a new one. */
export const PERSONAL_API_KEY_MAX_LIFETIME_DAYS = 365;
/**
 * Usable keys one person may hold at once: one per machine and tool is a handful. Who reaches
 * it reads a `CONFLICT` that names it and revokes one.
 */
export const PERSONAL_API_KEYS_PER_USER_MAX = 50;
/** The most scopes one key names: every key action, each everywhere or in a workspace. */
export const PERSONAL_API_KEY_SCOPES_MAX = 64;

/**
 * The use level of a personal key (CLI-PUBLISH-USE, "verwenden"): the rights to use a
 * resource that a technical account can be given. A key carries them so that its owner can
 * publish, from the CLI, a Workflow whose account uses a resource: the no-escalation rule asks
 * the publisher for each right the account holds, within the key's scopes. They add no
 * operation scope: a key reaches the operations of authoring, and no others.
 */
export const PERSONAL_API_KEY_USE_ACTIONS = [
  "connection.use",
  "data_store.insert",
  "data_store.execute",
  "data_store.records",
  "knowledge_base.use",
  "knowledge_base.ingest",
  "workflow.use"
] as const satisfies readonly PlatformAction[];

/**
 * The actions a personal key can name: reading, writing, deleting and publishing what the
 * owner builds, the use level, and the read-only infrastructure check under `system.view`.
 * Approving and administering stay with a signed-in person.
 */
export const PERSONAL_API_KEY_ACTIONS: readonly PlatformAction[] = ACTIONS.filter(
  (action) =>
    /\.(read|write|delete|publish)$/u.test(action) ||
    action === "system.view" ||
    PERSONAL_API_KEY_USE_ACTIONS.some((use) => use === action)
);

/** What a key's workspace and asset are compared with: the resource of a check. */
interface ScopedResource {
  name?: string;
  workspaceId?: string;
}

/**
 * One scope of a personal key: an action, and the workspace it is limited to where it is,
 * and within it one asset by name.
 */
export interface PersonalApiKeyScope {
  action: PlatformAction;
  workspaceId?: string;
  assetName?: string;
}

/** A workspace id as a scope names it: the id's own characters, nothing that ends a part. */
const SCOPE_WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/** An asset name as a scope names it: the characters any kind's names are made of. */
const SCOPE_ASSET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;

/**
 * Reads `<action>`, `<action>:<workspace>` or `<action>:<workspace>/<asset>`; nothing for any
 * other text. A scope written before NS-RETIRE with a name prefix (`agent.write:kai-`) reads
 * as a workspace that no workspace is, so it covers nothing: it narrows a key and never
 * widens it.
 */
export function parsePersonalApiKeyScope(scope: string): PersonalApiKeyScope | undefined {
  const separator = scope.indexOf(":");
  const action = separator === -1 ? scope : scope.slice(0, separator);
  const known = PERSONAL_API_KEY_ACTIONS.find((candidate) => candidate === action);
  if (known === undefined) return undefined;
  if (separator === -1) return { action: known };
  // This scope reaches one instance check, so a workspace or asset cannot narrow it.
  if (known === "system.view") return undefined;
  const resource = scope.slice(separator + 1);
  const slash = resource.indexOf("/");
  const workspaceId = slash === -1 ? resource : resource.slice(0, slash);
  const assetName = slash === -1 ? undefined : resource.slice(slash + 1);
  if (!SCOPE_WORKSPACE_PATTERN.test(workspaceId)) return undefined;
  if (assetName === undefined) return { action: known, workspaceId };
  return SCOPE_ASSET_PATTERN.test(assetName)
    ? { action: known, workspaceId, assetName }
    : undefined;
}

/** The scopes of a new key, or `VALIDATION_FAILED` naming the first that is no scope. */
export function requirePersonalApiKeyScopes(scopes: readonly string[]): PersonalApiKeyScope[] {
  if (scopes.length === 0) {
    throw new AppError("VALIDATION_FAILED", "A personal API key names at least one scope");
  }
  if (scopes.length > PERSONAL_API_KEY_SCOPES_MAX) {
    throw new AppError(
      "VALIDATION_FAILED",
      `A personal API key names at most ${PERSONAL_API_KEY_SCOPES_MAX} scopes`
    );
  }
  return scopes.map((scope) => {
    const parsed = parsePersonalApiKeyScope(scope);
    if (!parsed) {
      throw new AppError(
        "VALIDATION_FAILED",
        `'${scope}' is no scope of a personal API key. A scope is an action such as 'agent.write', optionally limited to a workspace by its id, 'agent.write:<workspace>', or to one asset in it, 'agent.write:<workspace>/<name>'`,
        { scope }
      );
    }
    return parsed;
  });
}

/** Whether a key's scope covers one action on one resource, as a workspace or asset grant does. */
function scopeCovers(
  scope: PersonalApiKeyScope,
  action: string,
  resource: ScopedResource | undefined
): boolean {
  if (scope.action !== action) return false;
  if (scope.workspaceId === undefined) return true;
  return (
    resource?.workspaceId === scope.workspaceId &&
    (scope.assetName === undefined || resource.name === scope.assetName)
  );
}

/**
 * Whether the key covers a check. A legacy key such as `config_assets.read` stands for several
 * actions on the whole instance, so each of them needs a scope without a workspace.
 */
export function personalApiKeyCovers(
  scopes: readonly string[],
  action: string,
  resource: ScopedResource | undefined,
  legacyActions: readonly string[] | undefined
): boolean {
  const parsed = scopes.flatMap((scope) => parsePersonalApiKeyScope(scope) ?? []);
  if (legacyActions !== undefined) {
    return legacyActions.every((target) =>
      parsed.some((scope) => scopeCovers(scope, target, undefined))
    );
  }
  return parsed.some((scope) => scopeCovers(scope, action, resource));
}

/** Whether a scope of the key names the action, anywhere it may be limited to. */
export function personalApiKeyNamesAction(scopes: readonly string[], action: string): boolean {
  return scopes.some((scope) => parsePersonalApiKeyScope(scope)?.action === action);
}

/**
 * The operation scopes a personal key's calls carry: reading the owner's own account, and the
 * asset operations of what its scopes read, write or publish. A key reaches no conversation,
 * no administration and none of the account's changes. `system.view` adds only the read-only
 * infrastructure check, still subject to the owner's current right. The use level adds none:
 * it counts on the operations the other scopes reach, such as a Workflow's publish, which
 * lends the rights of its account, and its start. The rows of a Data Store stay out of reach
 * until CLI-PARITY-4.
 */
export function operationScopesOfPersonalApiKey(scopes: readonly string[]): OperationScope[] {
  const granted = new Set<OperationScope>(["me:read"]);
  for (const scope of scopes) {
    const action = parsePersonalApiKeyScope(scope)?.action;
    if (action === undefined) continue;
    if (action === "system.view") granted.add("infrastructure:check");
    if (action.endsWith(".read")) granted.add("config_assets:read");
    if (action.endsWith(".write") || action.endsWith(".delete")) {
      granted.add("config_assets:write");
    }
    if (action.endsWith(".publish")) granted.add("config_assets:publish");
  }
  return [...granted];
}

/**
 * The key where it can still act for its owner now: the owner's, not revoked and not expired.
 * Nothing otherwise. What acts later for a key, such as a test run it started or a call of it
 * that waited for a confirmation, asks this before it acts.
 */
export async function usablePersonalApiKey(
  store: Pick<PersonalApiKeyStore, "resolvePersonalApiKey">,
  input: { clientInstanceId: ClientInstanceId; keyId: ApiCredentialId; ownerUserId: string },
  now = Date.now()
): Promise<PersonalApiKeyRecord | undefined> {
  const key = (
    await store.resolvePersonalApiKey({
      clientInstanceId: input.clientInstanceId,
      keyId: input.keyId
    })
  )?.key;
  return key &&
    key.ownerUserId === input.ownerUserId &&
    !key.revokedAt &&
    Date.parse(key.expiresAt) > now
    ? key
    : undefined;
}

/** Refuses an expiry in the past or further out than a key may live. */
export function requirePersonalApiKeyExpiry(expiresAt: string, now = Date.now()): void {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at) || at <= now) {
    throw new AppError("VALIDATION_FAILED", "A personal API key expires in the future");
  }
  if (at > now + PERSONAL_API_KEY_MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1000) {
    throw new AppError(
      "VALIDATION_FAILED",
      `A personal API key lives at most ${PERSONAL_API_KEY_MAX_LIFETIME_DAYS} days`
    );
  }
}

/** Letters a person reads and types without confusion: no vowels, no 0/O or 1/I. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_RANDOM_BYTES = 32;

export function createConnectCodeId(): string {
  return createPlatformId("ccode");
}

/** A new pair: the code a person types, as `ABCD-EFGH`, and the CLI's own long code. */
export function createConnectCodePair(): { userCode: string; deviceCode: string } {
  const crypto = requireCrypto();
  const letters = new Uint8Array(USER_CODE_LENGTH);
  crypto.getRandomValues(letters);
  // 256 is a multiple of 20 plus 16; the bias toward the first 16 letters is under 1 in 12.
  const code = [...letters].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  const device = new Uint8Array(DEVICE_CODE_RANDOM_BYTES);
  crypto.getRandomValues(device);
  return {
    userCode: `${code.slice(0, 4).join("")}-${code.slice(4).join("")}`,
    deviceCode: [...device].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  };
}

/**
 * The code as it is stored and compared: upper case, without the dash or spaces a person
 * types. Nothing for text that cannot be a code.
 */
export function normalizeUserCode(input: string): string | undefined {
  const normalized = input.toUpperCase().replace(/[\s-]/gu, "");
  return normalized.length === USER_CODE_LENGTH &&
    [...normalized].every((letter) => USER_CODE_ALPHABET.includes(letter))
    ? normalized
    : undefined;
}

/** The hash of either part of a connect code. */
export async function hashConnectCode(code: string): Promise<string> {
  const digest = await requireCrypto().subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireCrypto(): Crypto {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues || !crypto.subtle) {
    throw new AppError("INTERNAL", "Secure code generation is unavailable");
  }
  return crypto;
}

/** The id and secret material of a new personal key, in the format of every API key. */
export async function createPersonalApiKeyMaterial(): Promise<{
  id: ApiCredentialId;
  secret: string;
  secretHash: string;
  keyPrefix: string;
}> {
  const id = createApiCredentialId();
  return { id, ...(await createApiCredentialSecretMaterial(id)) };
}
