import type { PersonalApiKey, PlatformContext } from "@vivd-catalyst/api-client";

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

/** What a key may name: reading, writing, deleting and publishing; never using or approving. */
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

/** The actions of the offer the person holds somewhere: on the instance or in a Namespace. */
export function heldKeyActions(
  offer: readonly string[],
  context: PlatformContext | undefined
): string[] {
  const held = new Set([
    ...(context?.actions ?? []),
    ...(context?.namespaces ?? []).flatMap((namespace) => namespace.actions)
  ]);
  return offer.filter((action) => held.has(action));
}

/** A Namespace prefix as the instance writes one: lowercase words joined by hyphens, `kai-`. */
const NAMESPACE_PREFIX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-$/u;

/** Whether a typed Namespace is one the instance would take. Empty means no limit. */
function isNamespacePrefix(value: string): boolean {
  return NAMESPACE_PREFIX.test(value.trim());
}

/**
 * The scopes of a new key: each chosen action, limited to the Namespace where one is given,
 * as `agent.write:kai-`.
 */
export function buildPersonalKeyScopes(actions: readonly string[], namespace: string): string[] {
  const prefix = namespace.trim();
  return actions.map((action) => (prefix ? `${action}:${prefix}` : action));
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
  /** Empty for a key over every Namespace the person holds the actions in. */
  namespace: string;
  expiryDays: PersonalKeyExpiryDays;
}

export function initialPersonalKeyDraft(actions: readonly string[], name = ""): PersonalKeyDraft {
  return {
    name,
    actions: [...actions],
    namespace: "",
    expiryDays: DEFAULT_PERSONAL_KEY_EXPIRY_DAYS
  };
}

/** The first thing the draft lacks before it can be sent. */
export type PersonalKeyDraftProblem = "name" | "scopes" | "namespace";

export function personalKeyDraftProblem(
  draft: PersonalKeyDraft
): PersonalKeyDraftProblem | undefined {
  if (!draft.name.trim()) return "name";
  if (draft.actions.length === 0) return "scopes";
  if (draft.namespace.trim() && !isNamespacePrefix(draft.namespace)) return "namespace";
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
    scopes: buildPersonalKeyScopes(draft.actions, draft.namespace),
    expiresAt: personalKeyExpiresAt(draft.expiryDays, now)
  };
}
