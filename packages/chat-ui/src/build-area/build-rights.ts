import type { ApiUser, PlatformContext } from "@vivd-catalyst/api-client";

/** The right that reads every agent and skill of the instance. */
const INSTANCE_READ_PERMISSION = "config_assets.read";
/** The right that writes and deletes every agent and skill of the instance. */
const INSTANCE_WRITE_PERMISSION = "config_assets.write";

/** The asset kind of agents, as the instance names it. */
export const AGENT_ASSET_KIND = "agent";

type AssetVerb = "read" | "write" | "delete";

/** A Namespace the reader holds a right in, as the picker and the filter name it. */
export interface BuildNamespace {
  prefix: string;
  displayName: string;
}

/**
 * A workspace whose own assets the reader holds a right on, as the scope names it: a Shared
 * Workspace, or the reader's own Personal Workspace.
 */
interface BuildWorkspace {
  id: string;
  name: string;
  /** The reader is a member: a new agent made there starts offered there. */
  member: boolean;
  /** The reader's Personal Workspace, which Studio names "Personal". */
  personal?: true;
}

/**
 * What the reader may do in Build, as far as the browser can know it: the rights on the whole
 * instance from the session and the platform context, and the rights per Namespace and per
 * workspace from the platform context. A grant
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
  /** The Namespaces the reader holds any right in, by prefix. */
  namespaces: readonly BuildNamespace[];
  /** The reader holds a right on some of the instance's own assets. */
  readsInstance: boolean;
  /** The Shared Workspaces whose own assets the reader holds a right on. */
  workspaces: readonly BuildWorkspace[];
  may(
    verb: Exclude<AssetVerb, "read">,
    asset: { kind: string; namespace?: string; workspaceId?: string }
  ): boolean;
  /**
   * The reader may start a new asset of the kind: in the workspace named, or without one
   * somewhere among the instance's own assets.
   */
  mayCreate(kind: string, workspaceId?: string): boolean;
  /** The Namespaces a new asset of the kind may be named in, by prefix. */
  creatableNamespaces(kind: string): readonly BuildNamespace[];
}

export function resolveBuildRights(
  user: Pick<ApiUser, "permissions"> | undefined,
  context: PlatformContext | undefined
): BuildRights {
  const instanceRead = Boolean(user?.permissions.includes(INSTANCE_READ_PERMISSION));
  const instanceWrite = Boolean(user?.permissions.includes(INSTANCE_WRITE_PERMISSION));
  const held = context?.namespaces ?? [];
  // What the instance says the reader holds on all of a kind's assets. A kind is read by its
  // own actions: the session's keys name agents and skills and no kind that came later.
  const onInstance = context?.actions ?? [];
  // The read actions a grant allows on one asset or one workspace's assets: the kind then has
  // a list, and the instance decides which assets stand in it.
  const onSingleAssets = context?.assetActions ?? [];
  const verbs = ["read", "write", "delete"] as const;
  const action = (kind: string, verb: AssetVerb): string | undefined =>
    context?.kinds.find((candidate) => candidate.kind === kind)?.actions[verb];
  const holds = (kind: string, verb: AssetVerb, prefix: string | undefined): boolean => {
    const name = action(kind, verb);
    return (
      name !== undefined &&
      prefix !== undefined &&
      held.some((namespace) => namespace.prefix === prefix && namespace.actions.includes(name))
    );
  };
  const creatableNamespaces = (kind: string) =>
    held.filter((namespace) => holds(kind, "write", namespace.prefix)).map(toBuildNamespace);
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
    instanceRead ||
    instanceWrite ||
    onInstance.length > 0 ||
    onSingleAssets.length > 0 ||
    held.length > 0;

  const readsAny = readsInstance || inWorkspaces.length > 0;
  return {
    readsAny,
    reads: (kind) =>
      verbs.some((verb) => {
        const name = action(kind, verb);
        return name !== undefined && onInstance.includes(name);
      }) ||
      onSingleAssets.includes(action(kind, "read") ?? "") ||
      held.some((namespace) => verbs.some((verb) => holds(kind, verb, namespace.prefix))) ||
      inWorkspaces.some((workspace) => verbs.some((verb) => holdsIn(kind, verb, workspace.id))),
    instanceWrite,
    namespaces: held.map(toBuildNamespace),
    readsInstance,
    workspaces: [
      ...inWorkspaces.map(({ id, name, member }) => ({ id, name, member })),
      ...(readsAny
        ? ownWorkspaces.map(({ id, name }) => ({ id, name, member: true, personal: true as const }))
        : [])
    ],
    may: (verb, asset) =>
      instanceWrite ||
      (asset.workspaceId === undefined
        ? holds(asset.kind, verb, asset.namespace)
        : holdsIn(asset.kind, verb, asset.workspaceId)),
    mayCreate: (kind, workspaceId) =>
      instanceWrite ||
      (workspaceId === undefined
        ? creatableNamespaces(kind).length > 0
        : holdsIn(kind, "write", workspaceId)),
    creatableNamespaces
  };
}

function toBuildNamespace(namespace: BuildNamespace): BuildNamespace {
  return { prefix: namespace.prefix, displayName: namespace.displayName };
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

/** The owner the reader chose last in this browser: `instance`, a workspace's id, or nothing. */
export function readLastBuildScope(): string | undefined {
  try {
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeLastBuildScope(scope: string): void {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // A browser that refuses storage opens Studio in the scope it starts in.
  }
}
