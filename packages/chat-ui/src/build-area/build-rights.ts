import type { ApiUser, PlatformContext } from "@vivd-catalyst/api-client";

/** The right that reads every agent and skill of the instance. */
const INSTANCE_READ_PERMISSION = "config_assets.read";
/** The right that writes and deletes every agent and skill of the instance. */
const INSTANCE_WRITE_PERMISSION = "config_assets.write";

type AssetVerb = "read" | "write" | "delete";

/** A Namespace the reader holds a right in, as the picker and the filter name it. */
export interface BuildNamespace {
  prefix: string;
  displayName: string;
}

/**
 * What the reader may do in Build, as far as the browser can know it: the rights on the whole
 * instance from the session and the platform context, and the rights per Namespace from the
 * platform context. A grant
 * on one single asset is in neither, so such an asset opens read-only here. The instance
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
  may(verb: Exclude<AssetVerb, "read">, asset: { kind: string; namespace?: string }): boolean;
  /** The reader may start a new asset of the kind somewhere. */
  mayCreate(kind: string): boolean;
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

  return {
    readsAny: instanceRead || instanceWrite || onInstance.length > 0 || held.length > 0,
    reads: (kind) =>
      verbs.some((verb) => {
        const name = action(kind, verb);
        return name !== undefined && onInstance.includes(name);
      }) || held.some((namespace) => verbs.some((verb) => holds(kind, verb, namespace.prefix))),
    instanceWrite,
    namespaces: held.map(toBuildNamespace),
    may: (verb, asset) => instanceWrite || holds(asset.kind, verb, asset.namespace),
    mayCreate: (kind) => instanceWrite || creatableNamespaces(kind).length > 0,
    creatableNamespaces
  };
}

function toBuildNamespace(namespace: BuildNamespace): BuildNamespace {
  return { prefix: namespace.prefix, displayName: namespace.displayName };
}
