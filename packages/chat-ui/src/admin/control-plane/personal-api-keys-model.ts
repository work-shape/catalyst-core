import type { PersonalApiKey, PlatformContext } from "@work-shape/catalyst-api-client";
import { CONNECTION_ACTIONS } from "@work-shape/catalyst-core";

/** How long a new key lives, in days. The instance takes at most a year. */
export const PERSONAL_KEY_EXPIRY_DAYS = [30, 90, 365] as const;
export type PersonalKeyExpiryDays = (typeof PERSONAL_KEY_EXPIRY_DAYS)[number];
const DEFAULT_PERSONAL_KEY_EXPIRY_DAYS: PersonalKeyExpiryDays = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The end of a key that lives `days` from `now`. */
function personalKeyExpiresAt(days: PersonalKeyExpiryDays, now = new Date()): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

/** The choice a select field hands back, or nothing for a value that is none. */
export function personalKeyExpiryOf(value: string): PersonalKeyExpiryDays | undefined {
  return PERSONAL_KEY_EXPIRY_DAYS.find((days) => String(days) === value);
}

/**
 * The asset-authoring actions every instance has, offered when the instance has not said yet
 * which kinds it runs.
 */
const BASE_KEY_ACTIONS = [
  "agent.read",
  "agent.write",
  "agent.delete",
  "skill.read",
  "skill.write",
  "skill.delete"
];

/**
 * What a key's authoring scopes name: reading, writing, deleting and publishing; never
 * approving. The use level is offered beside them (`personalKeyUseOffer`).
 */
const KEY_ACTION = /\.(read|write|delete|publish)$/u;

/**
 * The actions a new key offers: the authoring actions of agents and skills and of every kind
 * the instance lists. Which of them the person holds, the instance checks when the key is
 * issued.
 */
export function personalKeyActionOffer(context: PlatformContext | undefined): string[] {
  const fromKinds = (context?.kinds ?? []).flatMap(({ actions }) => [
    actions.read,
    actions.write,
    actions.delete,
    ...(actions.publish ? [actions.publish] : [])
  ]);
  return [...new Set([...BASE_KEY_ACTIONS, ...fromKinds])].filter((action) =>
    KEY_ACTION.test(action)
  );
}

/**
 * The use level a new key offers: the rights to use a Connection, a Data Store, a Knowledge
 * Base or a Workflow that the person holds somewhere, as the instance names them. A key with
 * them publishes a Workflow whose technical account uses them (CLI-PUBLISH-USE).
 */
export function personalKeyUseOffer(context: PlatformContext | undefined): string[] {
  return [...(context?.useActions ?? [])];
}

/**
 * What the key `catalyst setup` asks for starts with: the reading, writing and publishing
 * rights the person holds among the ones offered, and the use level without `connection.use`.
 * Deleting is ticked by hand, and so is `connection.use`: with it the results of a
 * Connection's calls exposed to outside clients are copied to the computer that holds the key,
 * a choice of its own that starts off (connections-and-secrets.md, Exposure to outside
 * clients).
 */
export function setupKeyActions(context: PlatformContext | undefined): string[] {
  const offered = new Set(personalKeyActionOffer(context));
  return [
    ...(context?.authoringActions ?? []).filter((action) => offered.has(action)),
    ...personalKeyUseOffer(context).filter((action) => action !== CONNECTION_ACTIONS.use)
  ];
}

/**
 * Whether the address the CLI opened asks for the use level: `catalyst setup` adds
 * `level=use`, so the key a local agent gets can publish what its person may publish.
 */
export function connectCodeAsksUseLevel(search: string): boolean {
  return new URLSearchParams(search).getAll("level").includes("use");
}

/** An asset's id as a key's scope may name it: the characters any kind's names are made of. */
const SCOPE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;

/** Whether a typed asset id is one the instance would take in a scope. Empty means none. */
function isScopeAssetName(value: string): boolean {
  return SCOPE_ASSET_NAME.test(value.trim());
}

/** Where a key's scopes are limited to: what one workspace owns, or one asset of it. */
export interface PersonalKeyLimit {
  /** Empty for no limit. */
  workspaceId: string;
  /** Empty for every asset of the workspace. Ignored without a workspace. */
  assetName: string;
}

/**
 * The scopes of a new key: each chosen action, limited to the workspace where one is given, as
 * `agent.write:<workspace id>`, and within it to one asset, `agent.write:<workspace id>/<id>`.
 */
export function buildPersonalKeyScopes(
  actions: readonly string[],
  limit: PersonalKeyLimit
): string[] {
  const workspaceId = limit.workspaceId.trim();
  const assetName = limit.assetName.trim();
  const resource = workspaceId && (assetName ? `${workspaceId}/${assetName}` : workspaceId);
  return actions.map((action) => (resource ? `${action}:${resource}` : action));
}

/** A scope of an issued key, read back: its action, and the workspace and asset it is limited to. */
export function personalKeyScopeParts(scope: string): {
  action: string;
  workspaceId?: string;
  assetName?: string;
} {
  const colon = scope.indexOf(":");
  if (colon < 0) return { action: scope };
  const action = scope.slice(0, colon);
  const resource = scope.slice(colon + 1);
  const slash = resource.indexOf("/");
  return slash < 0
    ? { action, workspaceId: resource }
    : { action, workspaceId: resource.slice(0, slash), assetName: resource.slice(slash + 1) };
}

/**
 * The keys a person tells apart only by how they start: those whose owner holds another key of
 * the same name. Every other key is told by its name.
 */
export function keysSharingAName(keys: readonly PersonalApiKey[]): Set<string> {
  const nameOf = (key: PersonalApiKey) => `${key.ownerUserId}\n${key.name.trim().toLowerCase()}`;
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(nameOf(key), (counts.get(nameOf(key)) ?? 0) + 1);
  return new Set(keys.filter((key) => (counts.get(nameOf(key)) ?? 0) > 1).map((key) => key.id));
}

/** How many letters of a key's id tell it apart from the person's other keys of that name. */
const KEY_START_ID_LETTERS = 8;

/**
 * How a key starts, as a person tells it apart: the instance stores `cat.apic_<id>.`, shown as
 * `cat.apic_` with the first letters of the id, `cat.apic_1f0c2a9e…`.
 */
export function personalKeyStart(keyPrefix: string): string {
  const prefix = keyPrefix.replace(/\.$/u, "");
  const end = prefix.indexOf("_") + 1 + KEY_START_ID_LETTERS;
  return prefix.length > end ? `${prefix.slice(0, end)}…` : prefix;
}

export type PersonalKeyState = "active" | "revoked" | "expired";

export function personalKeyState(key: PersonalApiKey, now = new Date()): PersonalKeyState {
  if (key.revokedAt) return "revoked";
  return new Date(key.expiresAt).getTime() > now.getTime() ? "active" : "expired";
}

const CONNECT_CODE_LETTERS = 8;

/**
 * A connect code as a person typed or pasted it, written the way the CLI shows it: upper case,
 * a dash after the fourth letter, anything else dropped.
 */
export function formatConnectCode(input: string): string {
  const letters = input
    .toUpperCase()
    .replace(/[^A-Z]/gu, "")
    .slice(0, CONNECT_CODE_LETTERS);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/** Whether the code holds all its letters and can be looked up. */
export function isCompleteConnectCode(code: string): boolean {
  return formatConnectCode(code).replace("-", "").length === CONNECT_CODE_LETTERS;
}

/** The code the CLI sent the person here with: `/settings/you/api-keys?code=ABCD-EFGH`. */
export function connectCodeOfSearch(search: string): string {
  return formatConnectCode(new URLSearchParams(search).get("code") ?? "");
}

/** The address the CLI and a script talk to, as a person copies it beside the key. */
export function instanceUrl(apiBaseUrl: string, origin: string): string {
  return new URL(apiBaseUrl || "/", origin).toString().replace(/\/$/u, "");
}

/** What a person fills in for a new key, here or for a CLI's connect code. */
export interface PersonalKeyDraft {
  name: string;
  actions: string[];
  /** Empty for a key over everywhere the person holds the actions. */
  workspaceId: string;
  /** Empty for every asset of the workspace. */
  assetName: string;
  expiryDays: PersonalKeyExpiryDays;
}

/**
 * A new key starts with no scope ticked: it gets only what the person ticks. Ticked in advance,
 * every right the person holds went into the key unless they found and unticked each one, and
 * a click on the scope they wanted took it away. The one exception is the use level a CLI's
 * `setup` asks for, which its confirmation starts with (`actions`).
 */
export function initialPersonalKeyDraft(
  name = "",
  actions: readonly string[] = []
): PersonalKeyDraft {
  return {
    name,
    actions: [...actions],
    workspaceId: "",
    assetName: "",
    expiryDays: DEFAULT_PERSONAL_KEY_EXPIRY_DAYS
  };
}

/** The first thing the draft lacks before it can be sent. */
export type PersonalKeyDraftProblem = "name" | "scopes" | "assetName";

export function personalKeyDraftProblem(
  draft: PersonalKeyDraft
): PersonalKeyDraftProblem | undefined {
  if (!draft.name.trim()) return "name";
  if (draft.actions.length === 0) return "scopes";
  if (draft.workspaceId && draft.assetName.trim() && !isScopeAssetName(draft.assetName)) {
    return "assetName";
  }
  return undefined;
}

/** The body of the request that issues the drafted key, or nothing while it is incomplete. */
export function personalKeyRequest(
  draft: PersonalKeyDraft,
  now = new Date()
): { name: string; scopes: string[]; expiresAt: string } | undefined {
  if (personalKeyDraftProblem(draft)) return undefined;
  return {
    name: draft.name.trim(),
    scopes: buildPersonalKeyScopes(draft.actions, draft),
    expiresAt: personalKeyExpiresAt(draft.expiryDays, now)
  };
}
