import type { AssetScope } from "./asset-kinds";
import type { StorePage } from "./paging";
import type { AuditActor } from "./audit";
import type { AgentConfig, SkillConfig } from "./config";
import type { CollaborationWorkspaceKind } from "./collaboration-workspace";
import type {
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId
} from "./ids";
import type { JsonObject } from "./json";
import { assetObjectPrefix, type FileSetId } from "./pages";

/**
 * The id of a registered asset kind, such as `agent`. The registry of the instance says which
 * exist; the store keeps whatever kind a checked write names.
 */
export type ConfigAssetKind = string;

export type AgentAvailabilityMode = "all" | "selected";

/**
 * Where an agent may be used. Availability is an access rule: an agent without an availability
 * record is hidden everywhere.
 */
export interface AgentAvailability {
  mode: AgentAvailabilityMode;
  /** With `selected`: whether the agent is available in Personal Workspaces. */
  personalWorkspaces: boolean;
  /** With `selected`: the Shared Workspaces the agent is available in. */
  collaborationWorkspaceIds: CollaborationWorkspaceId[];
}

/**
 * Availability given to agents a mutation batch creates or revives.
 * `selected_when_replacing_selected` is the config push rule: a batch that also deletes a
 * `selected` agent is treated as a rename, so its new agents start hidden instead of `all`.
 */
export type InitialAgentAvailability = "all" | "selected" | "selected_when_replacing_selected";

export function resolveInitialAgentAvailabilityMode(
  initial: InitialAgentAvailability | undefined,
  deletesSelectedAgent: boolean
): AgentAvailabilityMode {
  if (initial === "selected_when_replacing_selected") {
    return deletesSelectedAgent ? "selected" : "all";
  }
  return initial ?? "all";
}

export function isAgentAvailableInWorkspace(
  availability: AgentAvailability | undefined,
  workspace: { kind: CollaborationWorkspaceKind; id?: CollaborationWorkspaceId }
): boolean {
  if (!availability) {
    return false;
  }
  if (availability.mode === "all") {
    return true;
  }
  return workspace.kind === "personal"
    ? availability.personalWorkspaces
    : workspace.id !== undefined && availability.collaborationWorkspaceIds.includes(workspace.id);
}

export interface RuntimeAssetSnapshot {
  version: number;
  defaultAgentName?: string;
  agents: AgentConfig[];
  skills: SkillConfig[];
}

export interface ConfigAssetSource {
  getSnapshot(): Promise<RuntimeAssetSnapshot>;
}

export interface ConfigAssetRecord {
  id: string;
  clientInstanceId: ClientInstanceId;
  kind: ConfigAssetKind;
  name: string;
  /** The owner. The Namespace is not part of the record: it is derived from the name. */
  scope: AssetScope;
  status: "active" | "deleted";
  activeRevisionId: string;
  revision: number;
  config: JsonObject | null;
  /** The file set of the active revision, for a kind whose revisions hold files. */
  fileSetId?: FileSetId;
  /** The commit and tree of the active revision, for an asset whose content is a repository. */
  commit?: string;
  tree?: string;
  /**
   * The published pointer of a `draft_published` kind, with the number and the file set of
   * the revision it names. Absent before the first publish and on every `active` kind, where
   * `activeRevisionId` is the live one. Ask `liveRevisionId` which one serves.
   */
  publishedRevisionId?: string;
  publishedRevision?: number;
  publishedFileSetId?: FileSetId;
  /** The content of the published revision: what a holder of the use right alone is shown. */
  publishedConfig?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigAssetRevisionRecord {
  id: string;
  assetId: string;
  clientInstanceId: ClientInstanceId;
  revision: number;
  operation: "create" | "update" | "delete" | "revert";
  config: JsonObject | null;
  /** The immutable file set of the revision, for a kind whose revisions hold files. */
  fileSetId?: FileSetId;
  /** The commit the revision names and its tree, for an asset whose content is a repository. */
  commit?: string;
  tree?: string;
  actor: AuditActor | null;
  origin?: { kind: "approval_request"; requestId: string; summary: string };
  globalVersion: number;
  createdAt: string;
}

/**
 * One bundle of the repository of an asset, as the ledger names it. The rows of an asset, in
 * the order of `sequence`, are what its repository is: the object store is never listed to
 * find that out, so an object no row names is never read.
 */
export interface AssetRepoBundle {
  assetId: string;
  sequence: number;
  /** Where the bytes are, in the `files` store: `assetRepoBundleObjectKey` of them. */
  objectKey: string;
  /** A full bundle stands on nothing; an incremental one on `prerequisiteCommit`. */
  kind: "full" | "incremental";
  tipCommit: string;
  prerequisiteCommit?: string;
  bytes: number;
  sha256: string;
  /** Set once a later full bundle holds what this one does. */
  supersededAt?: string;
  createdAt: string;
}

/** The folder of a conversation that holds the files of an asset's repository at one commit. */
export interface AssetCheckout {
  conversationId: ConversationId;
  folder: string;
  assetId: string;
  baseCommit: string;
  baseRevision: number;
}

/**
 * Where the bytes of a bundle are. The key holds the commit the bundle ends on and the SHA-256
 * of its bytes, so an object that is put a second time under a key has the same bytes, and
 * two different packs of one commit have two keys. Nothing is ever replaced by other bytes.
 */
export function assetRepoBundleObjectKey(input: {
  assetId: string;
  commit: string;
  sha256: string;
}): string {
  return `${assetObjectPrefix(input.assetId)}repo/${input.commit}-${input.sha256}.bundle`;
}

/** The bundle a save wrote, as it names it to the ledger before it puts the object. */
export type AssetRepoSaveBundle = Pick<
  AssetRepoBundle,
  "objectKey" | "kind" | "tipCommit" | "prerequisiteCommit" | "bytes" | "sha256"
>;

/**
 * One save of an asset's repository, as the ledger holds it from before its object is put.
 * It is keyed by the Operation Run of the save, so a save that is tried again finds it.
 */
export interface AssetRepoSave {
  assetId: string;
  operationRunId: OperationRunId;
  /** `pending` until the transaction that writes the revision made the bundle part of the repository. */
  state: "pending" | "live";
  /**
   * The time the commit of the save carries, in whole seconds. It is set once, so every
   * attempt of the run builds the same commit from the same files.
   */
  savedAt: string;
  /** The bundle the save named, once it did. */
  bundle?: AssetRepoSaveBundle;
}

/**
 * What a write of an asset whose content is a repository adds to the ledger, in the
 * transaction that writes the revision: the commit and tree the revision names, and the
 * pending bundle of the save, which becomes part of the repository. The save named the bundle
 * and put its object before the write.
 */
export interface AssetRepoWrite {
  commit: string;
  tree: string;
  /**
   * The commit the new one stands on, which must still be the draft's: a write whose base is
   * not the draft's commit any more is refused with `CONFLICT` and the reason `draft_moved`,
   * and nothing is written. `null` for the first commit of a repository.
   */
  baseCommit: string | null;
  /**
   * The save whose pending bundle holds `commit`. The bundle is full when `baseCommit` is
   * `null` and stands on `baseCommit` otherwise. A save the sweeper removed is refused.
   */
  operationRunId: OperationRunId;
  /** The folder that holds the files of `commit` after the write. */
  checkout?: { conversationId: ConversationId; folder: string };
}

export interface ConfigAssetState {
  version: number;
  defaultAgentName?: string;
}

export type ConfigAssetMutation =
  | {
      type: "upsert";
      kind: ConfigAssetKind;
      name: string;
      config: JsonObject;
      operation?: "revert";
      /**
       * The owner of the asset; the instance when left out. An existing asset keeps its
       * scope: a write that means another one is refused with `invalid_scope`.
       */
      scope?: AssetScope;
      /**
       * The write of a `draft_published` kind: it moves the draft pointer and nothing else. A
       * batch of such writes alone leaves the version of the instance's asset set as it is.
       */
      draft?: true;
      /** The file set of the revision, stored before the write, for a `files` kind. */
      fileSetId?: FileSetId;
      /** The commit of the revision and its bundle, for an asset whose content is a repository. */
      repository?: AssetRepoWrite;
      /**
       * The id a new asset gets, where its caller stored something under it before the write.
       * An asset that exists keeps its id, and a write that names another one is refused.
       */
      assetId?: string;
    }
  | {
      type: "delete";
      kind: ConfigAssetKind;
      name: string;
      /** The owner of the asset; the instance when left out. Another one is refused. */
      scope?: AssetScope;
    }
  | { type: "setDefaultAgent"; agentName: string | undefined };

/**
 * The asset set as it is under the lock every write of an asset takes: nothing changes it
 * until the write that holds the lock ends. A write checks here what it would leave.
 */
export interface LockedConfigAssetSet {
  state: ConfigAssetState;
  /**
   * `activeRevisionId` of every active asset. It names the set without loading its content,
   * so a writer that read the same ids before the lock need not read the set again.
   */
  listActiveRevisionIds(): Promise<string[]>;
  listActiveConfigAssets(): Promise<ConfigAssetRecord[]>;
}

/** What a list needs to decide whether its caller may read an asset, without its content. */
export interface ConfigAssetKey {
  id: string;
  kind: ConfigAssetKind;
  name: string;
  scope: AssetScope;
  /** Whether the published pointer names a revision. Told where a page of a list is read. */
  published?: boolean;
}

export interface ConfigAssetStore {
  getConfigAssetState(input: { clientInstanceId: ClientInstanceId }): Promise<ConfigAssetState>;
  listActiveConfigAssets(input: {
    clientInstanceId: ClientInstanceId;
    kind?: ConfigAssetKind;
    /** Only assets whose name starts with this text, such as a Namespace prefix. */
    namePrefix?: string;
  }): Promise<ConfigAssetRecord[]>;
  /**
   * One page of the active assets of a kind in one scope, in the byte order of their names.
   * The store reads keys in batches and asks `readable` for each, so the page holds only what
   * the caller may read and the content of no other asset is loaded.
   */
  listConfigAssetPage(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    scope: AssetScope;
    /** Only assets whose name starts with this text, such as a Namespace prefix. */
    namePrefix?: string;
    /** Only assets whose name contains this text, whatever the case. */
    nameContains?: string;
    /** The name the page starts after. */
    afterName?: string;
    limit: number;
    readable(asset: ConfigAssetKey): boolean;
  }): Promise<ConfigAssetRecord[]>;
  /**
   * The active assets of a kind that have a published revision, each with the content of that
   * revision, in the byte order of their names. One read of at most `limit` rows, whatever
   * the number of assets: a caller that needs to know whether more exist asks for one more
   * than it uses.
   */
  listPublishedConfigAssets(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    /** Only the assets of these names. */
    names?: readonly string[];
    limit: number;
  }): Promise<ConfigAssetRecord[]>;
  getConfigAsset(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    /**
     * Holds the asset at the revision that is read until the caller's transaction ends: a
     * write that gives it a new revision waits for that. Only inside a transaction, by a
     * writer whose row is only right for the revision it read.
     */
    lock?: "share";
  }): Promise<ConfigAssetRecord | undefined>;
  /**
   * The rows of the named assets, deleted ones included, in one read whatever their number.
   * A name that was never stored has no row.
   */
  listConfigAssetsByKey(input: {
    clientInstanceId: ClientInstanceId;
    keys: readonly { kind: ConfigAssetKind; name: string }[];
  }): Promise<ConfigAssetRecord[]>;
  /** The revisions of one asset, oldest first unless `newestFirst` is set. */
  listConfigAssetRevisions(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    page?: StorePage;
    /** Orders the revisions from the latest down, and reads `page.after` in that order. */
    newestFirst?: boolean;
  }): Promise<ConfigAssetRevisionRecord[]>;
  /** One revision of one asset, read without the others. */
  getConfigAssetRevision(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    revision: number;
  }): Promise<ConfigAssetRevisionRecord | undefined>;
  applyConfigAssetMutations(input: {
    clientInstanceId: ClientInstanceId;
    /**
     * The revision each asset the batch writes was read at, keyed `<kind>:<name>`. Every
     * upsert and delete needs its entry: a batch without one is refused, never written blind.
     * `null` expects that the name was never used. A deleted asset keeps its last revision, the
     * tombstone, and is created again only by a write that names it. A delete alone may name
     * `null` for an asset that is not there, deleted or never created, and writes nothing.
     */
    baseRevisions: Record<string, number | null>;
    /**
     * The id of the asset each revision was read of, keyed like `baseRevisions`, where the
     * writer knows it. A row of the name with another id is another asset that happens to be
     * at the same number, such as after a restored or replaced database: the batch is refused
     * with `CONFLICT` and the reason `asset_replaced`.
     */
    baseAssetIds?: Record<string, string>;
    baseDefaultAgentName?: string | null;
    actor?: AuditActor;
    origin?: ConfigAssetRevisionRecord["origin"];
    /** Defaults to `all`. */
    initialAgentAvailability?: InitialAgentAvailability;
    mutations: ConfigAssetMutation[];
    /**
     * Asked under the lock of the write, once the base revisions hold and before anything is
     * written. What it throws refuses the batch. It is where a writer checks what the batch
     * would leave against the set no other write can change any more.
     */
    validate?(locked: LockedConfigAssetSet): Promise<void>;
  }): Promise<{
    version: number;
    /**
     * The revision the write gave each asset it wrote, keyed like `baseRevisions`. A delete
     * of an asset that was not there wrote nothing and has no entry.
     */
    revisions: Record<string, number>;
    /** The id of each asset that has an entry in `revisions`, keyed the same way. */
    assetIds: Record<string, string>;
  }>;
  /**
   * Moves the published pointer of one asset to the revision of that number, in one
   * transaction. Refuses a number the asset has no content for with `NOT_FOUND`.
   */
  publishConfigAssetRevision(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    /**
     * The id of the asset whose right the caller checked. The name is resolved again under
     * the lock, and an asset of another id there, one created after the name was removed, is
     * refused with `CONFLICT` and the reason `revision_changed`: no write reaches an asset
     * nobody was authorized for.
     */
    assetId: string;
    revision: number;
    /**
     * The id of the revision the caller read and checked. The pointer moves only to that
     * revision: a name that was removed and created again in between has another revision of
     * the same number, and that is refused with `CONFLICT` and the reason `revision_changed`.
     */
    revisionId: string;
    /**
     * For a kind whose revisions hold files: refuses, with the reason `revision_files_removed`
     * and in the same transaction, a revision without a built file set this asset owns.
     */
    requireFiles?: true;
  }): Promise<{
    assetId: string;
    revision: number;
    /** The number the pointer named before, absent on the first publish. */
    replacedRevision?: number;
    fileSetId?: FileSetId;
  }>;
  /**
   * Moves the draft pointer back to the published revision. Refuses with `CONFLICT` when the
   * draft is not at `expectedRevision`, and with `nothing_published` before the first publish.
   */
  discardConfigAssetDraft(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    /** The asset whose right was checked, as in `publishConfigAssetRevision`. */
    assetId: string;
    expectedRevision: number;
  }): Promise<{ revision: number }>;
  /**
   * Removes one asset for good: its row, its revisions, the grant rows that name it and the
   * rows of its file sets, in one transaction. Answers the id whose stored objects the caller
   * removes after it. The version of the instance's asset set stays: only a kind outside the
   * runtime snapshot is removed this way.
   */
  removeConfigAsset(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    /** The asset whose right was checked, as in `publishConfigAssetRevision`. */
    assetId: string;
    expectedRevision: number;
  }): Promise<{ assetId: string; fileSetCount: number }>;
  /**
   * The bundles that make the repository of an asset, in the order they apply. A superseded
   * bundle is left out unless asked for: its object stays until its retention ends.
   */
  listAssetRepoBundles(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    includeSuperseded?: true;
  }): Promise<AssetRepoBundle[]>;
  /**
   * Starts a save, or finds the one the Operation Run started before. The first call writes a
   * pending row with the time of the save; every later call of the run answers that row, so a
   * second attempt commits with the same time. The asset need not exist yet.
   */
  beginAssetRepoSave(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    operationRunId: OperationRunId;
  }): Promise<AssetRepoSave>;
  /**
   * Names the bundle of a pending save, before its object is put, so no object is in the
   * store that no row names. Naming the same bundle again changes nothing. A save that named
   * another bundle before is refused with the reason `pending_bundle_differs` and that key,
   * unless `replaces` is that key: its caller removed that object first. A save that is not
   * pending any more is refused with the reason `save_not_pending`.
   */
  nameAssetRepoSaveBundle(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    operationRunId: OperationRunId;
    bundle: AssetRepoSaveBundle;
    replaces?: string;
  }): Promise<void>;
  /**
   * Removes the saves that are still pending and older than `olderThan`, oldest first:
   * `removeObject` is called for the object of each under the lock of its row, and the row
   * goes once it returned. A save that is being finished is left alone, and one that is swept
   * cannot be finished any more.
   */
  sweepPendingAssetRepoSaves(input: {
    olderThan: Date;
    limit: number;
    removeObject(object: {
      clientInstanceId: ClientInstanceId;
      assetId: string;
      objectKey: string;
    }): Promise<void>;
  }): Promise<{ removed: number }>;
  /** The checkout a folder of a conversation is, where it is one. */
  getAssetCheckout(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    folder: string;
  }): Promise<AssetCheckout | undefined>;
  /** Availability of every active agent that has a record, keyed by agent name. */
  listAgentAvailability(input: {
    clientInstanceId: ClientInstanceId;
    /** Only this agent's record, for a read of one agent that must not load every other. */
    agentName?: string;
  }): Promise<Map<string, AgentAvailability>>;
  /**
   * Rejects hiding the instance default agent, which must stay `all`. Moves the version of the
   * asset set in the same transaction, as every other change of what a run sees of it does.
   */
  setAgentAvailability(input: {
    clientInstanceId: ClientInstanceId;
    agentName: string;
    availability: AgentAvailability;
    /**
     * What the change was decided against. Given, the store compares under the lock of the
     * change and throws `CONFLICT` where the name is another asset's by now, or the stored
     * availability is another one. `null` expects that none is stored.
     */
    expectedAssetId?: string;
    expectedAvailability?: AgentAvailability | null;
  }): Promise<AgentAvailability>;
}
