import type { ApiUser, PlatformContext } from "@work-shape/catalyst-api-client";
import { forgetWhenSessionEnds } from "./shell-session";

/** The right that reads every agent and skill of the instance. */
const INSTANCE_READ_PERMISSION = "config_assets.read";
/** The right that writes and deletes every agent and skill of the instance. */
const INSTANCE_WRITE_PERMISSION = "config_assets.write";

/** The asset kind of agents, as the instance names it. */
export const AGENT_ASSET_KIND = "agent";
export const CONNECTION_ASSET_KIND = "connection";
/** The kinds the legacy keys read and write on the whole instance. */
const KEYED_KINDS = [AGENT_ASSET_KIND, "skill"] as const;

/** `publish` is named by a kind with a draft and a published revision only. */
export type AssetVerb = "read" | "write" | "delete" | "publish";

/**
 * What the reader may do with the assets of one kind, or with one asset of it, as far as the
 * browser can know it. The instance decides every call itself; this only chooses what a page
 * offers.
 */
export interface AssetRights {
  read: boolean;
  write: boolean;
  publish: boolean;
  delete: boolean;
}

/** No right on the assets of a kind. */
export const NO_ASSET_RIGHTS: AssetRights = {
  read: false,
  write: false,
  publish: false,
  delete: false
};

/** The four rights, each as `holds` answers it for its verb. */
export function assetRightsBy(holds: (verb: AssetVerb) => boolean): AssetRights {
  return {
    read: holds("read"),
    write: holds("write"),
    publish: holds("publish"),
    delete: holds("delete")
  };
}

/**
 * The reader's rights on one asset: what the instance says with the asset's record or its row
 * of a list the reader may do to it, decided with every grant and deny there is, those on the
 * asset itself included. Until the asset arrives, and from an instance that says nothing, the
 * rights on its owner stand.
 */
export function assetRightsOn(
  rights: AssetRights,
  asset: { allowed?: readonly AssetVerb[] } | undefined
): AssetRights {
  const allowed = asset?.allowed;
  return allowed === undefined ? rights : assetRightsBy((verb) => allowed.includes(verb));
}

/**
 * A workspace whose own assets the reader holds a right on, as the scope names it: a Shared
 * Workspace, or the reader's own Personal Workspace.
 */
export interface BuildWorkspace {
  id: string;
  name: string;
  /** The reader is a member: a new agent made there starts offered there. */
  member: boolean;
  /** The reader's Personal Workspace, which Studio names "Only me". */
  personal?: true;
}

/**
 * What the reader may do in Build, as far as the browser can know it: the rights on the whole
 * instance from the session and the platform context, and the rights per workspace from the
 * platform context. A grant
 * on one single asset tells that the kind has a list and nothing about the asset, so such an
 * asset opens read-only here. The instance
 * decides every call itself; this only chooses what the page offers.
 */
export interface BuildRights {
  /** The reader holds a right on the assets of at least one kind: the Build row shows. */
  readsAny: boolean;
  /** The reader holds a right on some asset of the kind: the kind has a rail item. */
  reads(kind: string): boolean;
  /** The reader may write every asset of the instance, and its default and availability. */
  instanceWrite: boolean;
  /** The reader holds a right on some of the instance's own assets. */
  readsInstance: boolean;
  /** The Shared Workspaces whose own assets the reader holds a right on. */
  workspaces: readonly BuildWorkspace[];
  /**
   * The reader holds the right on what the workspace owns, as the instance names it for that
   * workspace: through a membership, a grant there or a right on the whole instance.
   */
  holdsInWorkspace(kind: string, verb: AssetVerb, workspaceId: string): boolean;
  may(verb: Exclude<AssetVerb, "read">, asset: { kind: string; workspaceId?: string }): boolean;
  /**
   * The reader may start a new asset of the kind: in the workspace named, or without one
   * among the instance's own assets.
   */
  mayCreate(kind: string, workspaceId?: string): boolean;
}

export function resolveBuildRights(
  user: Pick<ApiUser, "permissions"> | undefined,
  context: PlatformContext | undefined
): BuildRights {
  const instanceRead = Boolean(user?.permissions.includes(INSTANCE_READ_PERMISSION));
  const instanceWrite = Boolean(user?.permissions.includes(INSTANCE_WRITE_PERMISSION));
  // What the instance says the reader holds on all of a kind's assets. A kind is read by its
  // own actions: the session's keys name agents and skills and no kind that came later.
  const onInstance = context?.actions ?? [];
  // The read actions a grant allows on one asset or one workspace's assets: the kind then has
  // a list, and the instance decides which assets stand in it.
  const onSingleAssets = context?.assetActions ?? [];
  const verbs = ["read", "write", "delete"] as const;
  const action = (kind: string, verb: AssetVerb): string | undefined =>
    context?.kinds.find((candidate) => candidate.kind === kind)?.actions[verb];
  // The legacy key writes agents and skills only. A kind that came later, such as Connections,
  // is written on the whole instance by its own action, which the platform context names.
  const keyedKind = (kind: string) => KEYED_KINDS.some((keyed) => keyed === kind);
  const onWholeInstance = (verb: AssetVerb, kind: string): boolean => {
    const named = verb === "publish" || !keyedKind(kind) ? action(kind, verb) : undefined;
    return named === undefined ? instanceWrite : onInstance.includes(named);
  };
  // Studio is open to a reader with a right on the instance's or a Shared Workspace's assets.
  // To that reader it also offers the Personal Workspace, where what the reader's agent made in
  // a personal conversation stands (manager, 2026-10-14); it opens Studio to nobody alone.
  const inWorkspaces = (context?.workspaces ?? []).filter(
    (workspace) => workspace.kind === "shared"
  );
  const ownWorkspaces = (context?.workspaces ?? []).filter(
    (workspace) => workspace.kind === "personal"
  );
  const holdsIn = (kind: string, verb: AssetVerb, workspaceId: string | undefined): boolean => {
    const name = action(kind, verb);
    return (
      name !== undefined &&
      [...inWorkspaces, ...ownWorkspaces].some(
        (workspace) => workspace.id === workspaceId && workspace.actions.includes(name)
      )
    );
  };
  const readsInstance =
    instanceRead || instanceWrite || onInstance.length > 0 || onSingleAssets.length > 0;

  const readsAny = readsInstance || inWorkspaces.length > 0;
  return {
    readsAny,
    reads: (kind) =>
      verbs.some((verb) => {
        const name = action(kind, verb);
        return name !== undefined && onInstance.includes(name);
      }) ||
      onSingleAssets.includes(action(kind, "read") ?? "") ||
      inWorkspaces.some((workspace) => verbs.some((verb) => holdsIn(kind, verb, workspace.id))),
    instanceWrite,
    readsInstance,
    holdsInWorkspace: holdsIn,
    workspaces: [
      ...inWorkspaces.map(({ id, name, member }) => ({ id, name, member })),
      ...(readsAny
        ? ownWorkspaces.map(({ id, name }) => ({ id, name, member: true, personal: true as const }))
        : [])
    ],
    // The write right on every asset of the instance writes and deletes them. It publishes only
    // a kind that names no publish right: where the kind names one, as an agent's
    // `agent.publish`, the instance publishes for its holders alone.
    may: (verb, asset) =>
      onWholeInstance(verb, asset.kind) ||
      (asset.workspaceId !== undefined && holdsIn(asset.kind, verb, asset.workspaceId)),
    mayCreate: (kind, workspaceId) =>
      onWholeInstance("write", kind) ||
      (workspaceId !== undefined && holdsIn(kind, "write", workspaceId))
  };
}

/**
 * The reader may start a new agent: the instance lets agents be created in the interface, and
 * the reader holds the right to write one somewhere. The list of agents in Build offers its
 * button by the same two.
 */
export function mayCreateAgents(
  rights: Pick<BuildRights, "mayCreate">,
  management: { allowAgentCreation: boolean } | undefined
): boolean {
  return management?.allowAgentCreation === true && rights.mayCreate(AGENT_ASSET_KIND);
}

/** The owner Studio works in: the instance's own assets, or what one workspace owns. */
export type BuildScope = { kind: "instance" } | { kind: "workspace"; workspaceId: string };

/**
 * The name a workspace of Studio is shown with: its own, "Personal" for the reader's Personal
 * Workspace, or its id where the reader is shown none.
 */
export function buildWorkspaceName(
  rights: Pick<BuildRights, "workspaces">,
  id: string,
  personal: string
): string {
  const workspace = rights.workspaces.find((candidate) => candidate.id === id);
  return workspace?.personal ? personal : (workspace?.name ?? id);
}

/** The value a scope is kept and chosen as: `instance`, or the workspace's id. */
const INSTANCE_SCOPE_VALUE = "instance";

/**
 * The owners Studio offers this reader: the instance where the reader holds a right on its own
 * assets, and every Shared Workspace whose own assets the reader holds a right on.
 */
export function buildScopes(rights: Pick<BuildRights, "readsInstance" | "workspaces">) {
  return [
    ...(rights.readsInstance ? [{ kind: "instance" as const }] : []),
    ...rights.workspaces.map((workspace) => ({
      kind: "workspace" as const,
      workspaceId: workspace.id
    }))
  ];
}

/**
 * The owner Studio works in: the one chosen last where it is still offered, otherwise the
 * instance, then the workspace the reader works in, then the first workspace offered.
 */
export function resolveBuildScope(
  rights: Pick<BuildRights, "readsInstance" | "workspaces">,
  chosen: string | undefined,
  activeWorkspaceId: string | undefined
): BuildScope {
  const offered = buildScopes(rights);
  const valueOf = (scope: BuildScope) =>
    scope.kind === "instance" ? INSTANCE_SCOPE_VALUE : scope.workspaceId;
  return (
    offered.find((scope) => valueOf(scope) === chosen) ??
    offered.find((scope) => scope.kind === "instance") ??
    offered.find((scope) => valueOf(scope) === activeWorkspaceId) ??
    offered[0] ?? { kind: "instance" }
  );
}

/** The value of a scope, as the picker and the browser keep it. */
export function buildScopeValue(scope: BuildScope): string {
  return scope.kind === "instance" ? INSTANCE_SCOPE_VALUE : scope.workspaceId;
}

/** The owner Studio worked in last in this browser, as `instance` or a workspace's id. */
const SCOPE_STORAGE_KEY = "vivd-catalyst:build-scope";

/** The owner chosen in this tab, which a browser that refuses storage keeps as well. */
let chosenInTab: string | undefined;
const scopeListeners = new Set<() => void>();

/** The owner the reader chose last in this browser: `instance`, a workspace's id, or nothing. */
export function readLastBuildScope(): string | undefined {
  if (chosenInTab !== undefined) return chosenInTab;
  try {
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the owner Studio works in, and tells a Studio that is open. */
export function storeLastBuildScope(scope: string): void {
  chosenInTab = scope;
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // A browser that refuses storage keeps the scope for this tab alone.
  }
  for (const listener of scopeListeners) listener();
}

// The owner is a workspace of the person signed in: the next person starts without it.
forgetWhenSessionEnds(() => {
  chosenInTab = undefined;
  try {
    window.localStorage.removeItem(SCOPE_STORAGE_KEY);
  } catch {
    // A browser that refuses storage kept the scope for this tab alone.
  }
  for (const listener of scopeListeners) listener();
});

/** Hears each owner Studio is set to work in. */
export function subscribeBuildScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => scopeListeners.delete(listener);
}

/**
 * Sets Studio to the owner of an asset whose page the person is taken to, so the page reads it
 * where it is: the workspace that owns it, by its id, or the instance.
 */
export function showOwnerInStudio(workspaceId: string | undefined): void {
  storeLastBuildScope(workspaceId ?? INSTANCE_SCOPE_VALUE);
}
