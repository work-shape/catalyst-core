import {
  AppError,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  INSTANCE_ASSET_SCOPE,
  ownerReachRefusal,
  type AgentAvailability,
  type AppAudience,
  type AssetOwnerReach,
  type AssetOwnerRung,
  type AssetScope,
  type ClientInstanceId,
  type CollaborationWorkspace,
  type OwnerReachUse,
  type PlatformStores,
  type LocaleCode,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { assetKindLabel } from "./asset-reference-labels";
import type { WorkflowAssetKind } from "../asset-kinds/shared";

/** A write as far as this rule reads it: a store mutation, or a definition a validate asks of. */
type OwnedWrite =
  | { type: "upsert"; kind: string; name: string; scope?: AssetScope; config: unknown }
  | { type: "delete"; kind: string; name: string }
  | { type: "setDefaultAgent"; agentName?: string | undefined };

interface Owned {
  kind: string;
  name: string;
  scope: AssetScope;
  definition: unknown;
}

/** What the owner check reads: the workspaces of one instance. */
export interface OwnerReachOptions {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "workspaces">;
}

/** An asset as the owner check names it. */
interface ReachSource {
  kind: string;
  name: string;
  scope: AssetScope;
}

/** What a source does with its owner's reach, as the server is asked it. */
type OwnerReachRequest =
  | {
      kind: "reference";
      target: ReachSource;
      acrossOwners: boolean;
      /**
       * The source is an asset the writer did not write and may not read: the refusal tells
       * nothing about it, including its name, kind or owner.
       */
      sourceUnread: boolean;
    }
  | { kind: "availability"; availability: AgentAvailability }
  | { kind: "app_audience"; audience: AppAudience };

/** Reads each workspace once for one check, however many pairs name it. */
function workspaceReader(options: OwnerReachOptions) {
  const read = new Map<string, Promise<CollaborationWorkspace | undefined>>();
  return (workspaceId: string) => {
    let workspace = read.get(workspaceId);
    if (!workspace) {
      workspace = options.stores.workspaces.getWorkspace(
        options.clientInstanceId,
        asCollaborationWorkspaceId(workspaceId)
      );
      read.set(workspaceId, workspace);
    }
    return workspace;
  };
}

type WorkspaceReader = ReturnType<typeof workspaceReader>;

async function ownerReach(
  scope: AssetScope,
  workspaces: WorkspaceReader
): Promise<AssetOwnerReach> {
  if (scope.kind === "instance") return { kind: "instance" };
  const workspace = await workspaces(scope.workspaceId);
  return { kind: "workspace", workspaceId: scope.workspaceId, workspaceKind: workspace?.kind };
}

/** Where an asset sits, as the ladder's words: only its person, a team by name, or everyone. */
interface Place {
  rung: AssetOwnerRung;
  team?: string;
}

async function placeOf(scope: AssetScope, workspaces: WorkspaceReader): Promise<Place> {
  if (scope.kind === "instance") return { rung: "everyone" };
  const workspace = await workspaces(scope.workspaceId);
  return workspace?.kind === "shared"
    ? { rung: "team", team: workspace.name }
    : { rung: "personal" };
}

function quoted(name: string, de: boolean): string {
  return de ? `„${name}“` : `"${name}"`;
}

/**
 * What an agent or person is told when a source names an asset of an owner it may not rely on
 * (2026-10-28): where each sits, and the next step: share the item with the source's place in
 * "Teilen…" where a person can, else ask an admin. The UI's words, never a command.
 */
function referenceSentence(
  names: { source: string; target: string },
  places: { source: Place; target: Place },
  de: boolean
): string {
  const { source, target } = places;
  const team = (place: Place) => quoted(place.team ?? (de ? "Team" : "team"), de);
  const is = (place: Place) => {
    if (place.rung === "personal") {
      return de ? "ist nur für dich („Nur ich“)" : 'is only for you ("Only me")';
    }
    if (place.rung === "everyone") return de ? "ist für Alle" : "is for everyone";
    return de ? `gehört zum Team ${team(place)}` : `belongs to the team ${team(place)}`;
  };
  const facts = de
    ? `${names.target} ${is(target)}. ${names.source} ${is(source)} und darf sich darum nicht darauf stützen.`
    : `${names.target} ${is(target)}. ${names.source} ${is(source)} and so may not rely on it.`;
  // A person shares up the ladder; moving something between two teams stays an admin's step.
  const shareable =
    source.rung !== "personal" &&
    (target.rung === "personal" || (target.rung === "team" && source.rung === "everyone"));
  if (!shareable) return `${facts} ${de ? "Bitte einen Admin darum." : "Ask an admin."}`;
  const to =
    source.rung === "everyone"
      ? de
        ? "Allen"
        : "everyone"
      : de
        ? `dem Team ${team(source)}`
        : `the team ${team(source)}`;
  return `${facts} ${
    de
      ? `Teile ${names.target} über „Teilen…“ mit ${to}, oder bitte einen Admin darum.`
      : `Share ${names.target} with ${to} using "Share…", or ask an admin.`
  }`;
}

/**
 * The one owner check (2026-10-28): something shared never relies on or exposes something a
 * Personal Workspace owns. The decision is `ownerReachRefusal` in core; this reads the owners'
 * workspaces and refuses in the caller's language, with the next step. Every reference a write
 * or publish checks, every availability that offers an agent, Knowledge Base or Connection, an
 * agent's place at creation and an App's audience at publish come through here, and so must a
 * move of an asset to another owner.
 */
export async function assertOwnerReach(
  options: OwnerReachOptions,
  source: ReachSource,
  use: OwnerReachRequest,
  locale: LocaleCode,
  workspaces: WorkspaceReader = workspaceReader(options)
): Promise<void> {
  const owner = await ownerReach(source.scope, workspaces);
  const decided: OwnerReachUse =
    use.kind === "reference"
      ? {
          kind: "reference",
          target: await ownerReach(use.target.scope, workspaces),
          acrossOwners: use.acrossOwners
        }
      : use;
  const refusal = ownerReachRefusal(owner, decided);
  if (refusal === undefined) return;
  const de = locale === "de";
  const label = `${assetKindLabel(source.kind, locale)} '${source.name}'`;
  if (use.kind === "reference" && decided.kind === "reference") {
    if (use.sourceUnread) {
      throw new AppError(
        "VALIDATION_FAILED",
        de
          ? "Dieses Asset kann nicht erstellt werden, weil ein Asset eines anderen Eigentümers darauf verweist. Ein Asset darf nur auf Assets im selben Arbeitsbereich oder in der Instanz verweisen. Bitte einen Admin darum."
          : "This asset cannot be created because an asset of another owner references it. An asset may reference only assets of its own workspace or the instance. Ask an admin.",
        { reason: "invalid_scope" }
      );
    }
    const personal =
      decided.target.kind === "workspace" && decided.target.workspaceKind !== "shared";
    const targetLabel = `${assetKindLabel(use.target.kind, locale)} ${quoted(use.target.name, de)}`;
    const sourceLabel = `${assetKindLabel(source.kind, locale)} ${quoted(source.name, de)}`;
    throw new AppError(
      "VALIDATION_FAILED",
      referenceSentence(
        { source: sourceLabel, target: targetLabel },
        {
          source: await placeOf(source.scope, workspaces),
          target: await placeOf(use.target.scope, workspaces)
        },
        de
      ),
      {
        reason: refusal,
        reference: {
          kind: use.target.kind,
          name: use.target.name,
          owner: use.target.scope,
          ...(personal ? { reach: "personal" } : {})
        },
        owner: source.scope
      }
    );
  }
  throw new AppError(
    "VALIDATION_FAILED",
    refusal === "app_instance_needs_shared_workspace"
      ? de
        ? `${label} liegt unter „Nur ich“, in einem persönlichen Arbeitsbereich, und kann darum nicht für Alle sein. Baue sie in einem Team-Arbeitsbereich, oder bitte einen Admin darum.`
        : `${label} is in a Personal Workspace ("Only me"), so it cannot be for everyone. Build it in a Shared Workspace, or ask an admin.`
      : de
        ? `${label} liegt unter „Nur ich“, in einem persönlichen Arbeitsbereich, und wird nur dort genutzt, nicht in einem Team oder von Allen. Lege das in einem Team-Arbeitsbereich oder für Alle an, oder bitte einen Admin darum.`
        : `${label} is in a Personal Workspace ("Only me") and is used only there, not in a team or by everyone. Create it in a Shared Workspace or for everyone, or ask an admin.`,
    { reason: refusal, asset: { kind: source.kind, name: source.name }, owner: source.scope }
  );
}

/**
 * Check owner pairs when writing their source or creating their target. Owners never change,
 * so editing an existing target leaves legacy pairs running. Each pair is decided by
 * `assertOwnerReach`: an instance Workflow may also reach a Shared Workspace's Apps, Data
 * Stores and Knowledge Bases, whose grants are checked at run time, never a Personal
 * Workspace's. Guardrail filters are absent from the reference inventory.
 */
export async function assertReferencesWithinOwners(
  kinds: readonly WorkflowAssetKind[],
  mutations: readonly OwnedWrite[],
  assets: readonly ConfigAssetRecord[],
  locale: LocaleCode,
  options: OwnerReachOptions
): Promise<void> {
  const key = (kind: string, name: string) => `${kind}:${name}`;
  const owned = new Map<string, Owned>(
    assets.map((asset) => [
      key(asset.kind, asset.name),
      { kind: asset.kind, name: asset.name, scope: asset.scope, definition: asset.config }
    ])
  );
  const existing = new Set(owned.keys());
  const touched = new Set<string>();
  const created = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.type === "setDefaultAgent") continue;
    const at = key(mutation.kind, mutation.name);
    touched.add(at);
    if (mutation.type === "delete") {
      owned.delete(at);
    } else {
      if (!existing.has(at)) created.add(at);
      owned.set(at, {
        kind: mutation.kind,
        name: mutation.name,
        scope: mutation.scope ?? INSTANCE_ASSET_SCOPE,
        definition: mutation.config
      });
    }
  }
  if (touched.size === 0) return;
  const kindsByName = new Map(kinds.map((kind) => [kind.kind, kind]));
  const workspaces = workspaceReader(options);
  for (const [at, asset] of owned) {
    const kind = kindsByName.get(asset.kind);
    const references = kind?.references;
    if (!references) continue;
    for (const reference of references(asset.definition)) {
      const named = owned.get(key(reference.kind, reference.name));
      if (!named || (!touched.has(at) && !created.has(key(named.kind, named.name)))) continue;
      // The same owner, or the instance: nothing to read.
      if (named.scope.kind === "instance" || assetScopesEqual(asset.scope, named.scope)) continue;
      await assertOwnerReach(
        options,
        asset,
        {
          kind: "reference",
          target: named,
          acrossOwners: kind.crossOwnerReferences?.includes(named.kind) === true,
          sourceUnread: !touched.has(at)
        },
        locale,
        workspaces
      );
    }
  }
}

/**
 * Refuses a write that makes an agent a workspace owns the instance's default (Felix,
 * 2026-10-14): the default is offered in every workspace, and a workspace's agent is its own.
 * Only a write that sets the default is asked, so one that leaves it is never refused here.
 */
export function assertDefaultOwnedByInstance(
  kinds: readonly WorkflowAssetKind[],
  mutations: readonly OwnedWrite[],
  assets: readonly ConfigAssetRecord[]
): void {
  const kind = kinds.find((each) => each.holdsInstanceDefault);
  const set = mutations.findLast((mutation) => mutation.type === "setDefaultAgent");
  if (!kind || set?.type !== "setDefaultAgent" || set.agentName === undefined) return;
  const name = set.agentName;
  const written = mutations.findLast(
    (mutation) =>
      mutation.type === "upsert" && mutation.kind === kind.kind && mutation.name === name
  );
  const scope =
    written?.type === "upsert"
      ? (written.scope ?? INSTANCE_ASSET_SCOPE)
      : assets.find((asset) => asset.kind === kind.kind && asset.name === name)?.scope;
  if (scope?.kind === "workspace") {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config ${kind.kind} '${name}' belongs to a workspace, and only a ${kind.kind} of the whole instance can be its default`,
      { reason: "default_owned_by_workspace" }
    );
  }
}
