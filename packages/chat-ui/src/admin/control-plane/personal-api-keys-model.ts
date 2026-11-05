import type { PersonalApiKey, PlatformContext } from "@work-shape/catalyst-api-client";
import {
  CONNECTION_ACTIONS,
  PERSONAL_API_KEY_ACCOUNT_ACTION,
  PERSONAL_API_KEY_ACCOUNT_LEVEL_ACTIONS,
  PERSONAL_API_KEY_INSPECT_ACTIONS,
  PERSONAL_API_KEY_WORKSPACES_ACTION
} from "@work-shape/catalyst-core";

/**
 * How long a new key lives: a number of days, or `never` for a key that lives until it is
 * revoked. The instance takes an expiry at most a year ahead, or none.
 */
export const PERSONAL_KEY_EXPIRIES = [30, 90, 365, "never"] as const;
export type PersonalKeyExpiry = (typeof PERSONAL_KEY_EXPIRIES)[number];
const DEFAULT_PERSONAL_KEY_EXPIRY: PersonalKeyExpiry = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The end of a key that lives `expiry` from `now`, or `null` for one that never expires. */
function personalKeyExpiresAt(expiry: PersonalKeyExpiry, now = new Date()): string | null {
  return expiry === "never" ? null : new Date(now.getTime() + expiry * DAY_MS).toISOString();
}

/** The choice a select field hands back, or nothing for a value that is none. */
export function personalKeyExpiryOf(value: string): PersonalKeyExpiry | undefined {
  return PERSONAL_KEY_EXPIRIES.find((expiry) => String(expiry) === value);
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
 * The authoring actions a new key may name, in the order the screen lists them: those of
 * agents and skills and of every kind the instance lists.
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
 * The authoring actions a new key offers over everywhere the person holds them: the ones of
 * `personalKeyActionOffer` the instance says the person holds somewhere. A right the person
 * lacks is not offered, so a key is never refused one the screen offered.
 */
export function personalKeyHeldActionOffer(context: PlatformContext | undefined): string[] {
  const held = new Set(context?.authoringActions ?? []);
  return personalKeyActionOffer(context).filter((action) => held.has(action));
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
 * The instance level a new key may carry (CLI-PARITY-6a): `usage.view`, `audit.view` and
 * `system.view`, which read the instance (usage, audit events, jobs, Operation Runs, Modules,
 * infrastructure and the check of the providers that `catalyst models check` runs) and change
 * nothing. Each is offered only to a person who holds the right now, and never ticked in
 * advance; the instance checks it again at issuance and at every call.
 */
const PERSONAL_KEY_INSTANCE_ACTIONS = PERSONAL_API_KEY_INSPECT_ACTIONS;

export function personalKeyInstanceOffer(context: PlatformContext | undefined): string[] {
  return PERSONAL_KEY_INSTANCE_ACTIONS.filter((action) =>
    (context?.instanceActions ?? []).includes(action)
  );
}

/** Whether an action is of the whole instance, which no workspace or asset narrows. */
function isPersonalKeyInstanceAction(action: string): boolean {
  return PERSONAL_KEY_INSTANCE_ACTIONS.some((instanceAction) => instanceAction === action);
}

/**
 * The account and workspaces level a new key may carry (CLI-PARITY-5): `account.manage`, the
 * person's own name, model preference and keys' revocation, and
 * `collaboration_workspace.manage`, the Shared Workspaces as the person's role in each allows.
 * No grant gives them, so every person is offered both; neither is ticked in advance, also not
 * for the key `catalyst setup` creates.
 */
export function personalKeyAccountOffer(context: PlatformContext | undefined): string[] {
  return context === undefined ? [] : [...PERSONAL_API_KEY_ACCOUNT_LEVEL_ACTIONS];
}

/** A workspace a key can be limited to, with what the person holds there. */
export interface PersonalKeyWorkspace {
  id: string;
  /** Absent for the person's Personal Workspace, which is named "Personal". */
  name?: string;
  /** The authoring actions the person holds on what the workspace owns, in the screen's order. */
  actions: string[];
  /** The use level the person may hand on in the workspace. */
  useActions: string[];
}

/**
 * The workspaces a key can be limited to, each with the authoring actions and the use level
 * the person holds there: a key limited to one offers those and no others.
 */
export function personalKeyWorkspaceOffer(
  context: PlatformContext | undefined
): PersonalKeyWorkspace[] {
  const order = personalKeyActionOffer(context);
  return (context?.workspaces ?? []).map((workspace) => ({
    id: workspace.id,
    ...(workspace.kind === "personal" ? {} : { name: workspace.name }),
    actions: order.filter((action) => workspace.actions.includes(action)),
    useActions: [...(workspace.useActions ?? [])]
  }));
}

/** What a key offers where it is limited: everywhere, or in one workspace. */
export interface PersonalKeyPlaceOffer {
  actions: readonly string[];
  useActions: readonly string[];
}

/**
 * What a key limited to the workspace offers, or over everywhere for none: only what the
 * person holds there.
 */
export function personalKeyOfferIn(
  everywhere: PersonalKeyPlaceOffer,
  workspaces: readonly PersonalKeyWorkspace[],
  workspaceId: string
): PersonalKeyPlaceOffer {
  if (!workspaceId) return everywhere;
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  return { actions: workspace?.actions ?? [], useActions: workspace?.useActions ?? [] };
}

/**
 * What stays ticked when the key is limited to the workspace, or to none: what the person holds
 * there. A workspace narrows the key, so the instance level and the account do not go with it.
 */
export function personalKeyActionsKeptIn(
  ticked: readonly string[],
  offer: {
    everywhere: PersonalKeyPlaceOffer;
    workspaces: readonly PersonalKeyWorkspace[];
    instanceActions: readonly string[];
    accountActions: readonly string[];
  },
  workspaceId: string
): string[] {
  const place = personalKeyOfferIn(offer.everywhere, offer.workspaces, workspaceId);
  const kept = new Set([
    ...place.actions,
    ...place.useActions,
    ...(workspaceId ? [] : offer.instanceActions),
    ...offer.accountActions.filter(
      (action) => !workspaceId || action !== PERSONAL_API_KEY_ACCOUNT_ACTION
    )
  ]);
  return ticked.filter((action) => kept.has(action));
}

/**
 * What a key confirmed for a connect code (`catalyst setup`, `catalyst login`) starts with:
 * every authoring action and every use right offered, which the person all holds, but deleting
 * and `connection.use`. A local agent holds the key, so a deletion stays a deliberate tick. With
 * `connection.use` the results of a Connection's calls exposed to outside clients are
 * copied to the computer that holds the key, a choice of its own that starts off
 * (connections-and-secrets.md, Exposure to outside clients). The instance level and the
 * account and workspaces level are no part of such a key.
 */
export function connectKeyActions(offer: PersonalKeyPlaceOffer): string[] {
  return [
    ...offer.actions.filter((action) => !action.endsWith(".delete")),
    ...offer.useActions.filter((action) => action !== CONNECTION_ACTIONS.use)
  ];
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
 * The actions a key limited this way carries: a key limited to a workspace leaves out the
 * instance level and the person's account, so narrowing a key never hands it a right of the
 * whole instance or the account; one limited to an asset leaves out the workspaces level too,
 * whose narrowest limit is a workspace.
 */
function actionsWithin(actions: readonly string[], limit: PersonalKeyLimit): string[] {
  if (!limit.workspaceId.trim()) return [...actions];
  return actions.filter(
    (action) =>
      !isPersonalKeyInstanceAction(action) &&
      action !== PERSONAL_API_KEY_ACCOUNT_ACTION &&
      (action !== PERSONAL_API_KEY_WORKSPACES_ACTION || !limit.assetName.trim())
  );
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
  return actionsWithin(actions, limit).map((action) =>
    resource ? `${action}:${resource}` : action
  );
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
  if (key.expiresAt === undefined) return "active";
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
  expiry: PersonalKeyExpiry;
}

/**
 * A new key starts with no scope ticked: it gets only what the person ticks, and "Select all"
 * ticks every one offered. A connect code's key starts with `connectKeyActions` (`actions`).
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
    expiry: DEFAULT_PERSONAL_KEY_EXPIRY
  };
}

/** The first thing the draft lacks before it can be sent. */
export type PersonalKeyDraftProblem = "name" | "scopes" | "assetName";

export function personalKeyDraftProblem(
  draft: PersonalKeyDraft
): PersonalKeyDraftProblem | undefined {
  if (!draft.name.trim()) return "name";
  if (actionsWithin(draft.actions, draft).length === 0) return "scopes";
  if (draft.workspaceId && draft.assetName.trim() && !isScopeAssetName(draft.assetName)) {
    return "assetName";
  }
  return undefined;
}

/** The body of the request that issues the drafted key, or nothing while it is incomplete. */
export function personalKeyRequest(
  draft: PersonalKeyDraft,
  now = new Date()
): { name: string; scopes: string[]; expiresAt: string | null } | undefined {
  if (personalKeyDraftProblem(draft)) return undefined;
  return {
    name: draft.name.trim(),
    scopes: buildPersonalKeyScopes(draft.actions, draft),
    expiresAt: personalKeyExpiresAt(draft.expiry, now)
  };
}
