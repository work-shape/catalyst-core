import type { AppAvailability, AppAudience } from "./app-audience";
import {
  AGENT_AVAILABILITY_MODES,
  ASSET_REPO_BUNDLE_KINDS,
  CONFIG_ASSET_CHANGE_OPERATIONS,
  type AgentUse
} from "@work-shape/catalyst-asset-schemas";
import type { AssetScope } from "./asset-kinds";
import type { AuditActor } from "./audit";
import type { CollaborationWorkspaceKind } from "./collaboration-workspace";
import type { AgentConfig, SkillConfig } from "./config";
import type {
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId
} from "./ids";
import type { JsonObject } from "./json";
import type { AccessDecision } from "./permissions";
import { assetObjectPrefix, type FileSetId } from "./pages";
import type { StorePage } from "./paging";

/**
 * The id of a registered asset kind, such as `agent`. The registry of the instance says which
 * exist; the store keeps whatever kind a checked write names.
 */
export type ConfigAssetKind = string;

export type AgentAvailabilityMode = (typeof AGENT_AVAILABILITY_MODES)[number];

/** Who uses an agent where it is available (AGENT-USE-1). */
export type { AgentUse };

/**
 * Where an asset may be used. The existing agent shape is shared by Connections and Knowledge
 * Bases; without a record, none of them receives workspace availability.
 */
export interface AgentAvailability {
  mode: AgentAvailabilityMode;
  /** With `selected`: whether the agent is available in Personal Workspaces. */
  personalWorkspaces: boolean;
  /** With `selected`: the Shared Workspaces the agent is available in. */
  collaborationWorkspaceIds: CollaborationWorkspaceId[];
}

/**
 * Availability given to agents a mutation batch creates or revives: every workspace, none,
 * or the one shared workspace the agent was made in. `selected_when_replacing_selected` is
 * the release rule: a batch that also deletes a `selected` agent is treated as a rename, so
 * its new agents start hidden instead of `all`.
 */
export type InitialAgentAvailability =
  | "all"
  | "hidden"
  /**
   * Hidden, and marked as awaiting its first publish: a workspace's agent whose maker may not
   * approve its publish. Only the approval of that publish offers it in its workspace (WS-PUB-1b).
   */
  | "hidden_until_first_publish"
  | { collaborationWorkspaceId: CollaborationWorkspaceId }
  | "selected_when_replacing_selected";

export function resolveInitialAgentAvailability(
  initial: InitialAgentAvailability | undefined,
  deletesSelectedAgent: boolean
): Pick<AgentAvailability, "mode" | "collaborationWorkspaceIds"> & {
  awaitingFirstPublish?: true;
} {
  const hidden = { mode: "selected" as const, collaborationWorkspaceIds: [] };
  if (initial === undefined || initial === "all") {
    return { mode: "all", collaborationWorkspaceIds: [] };
  }
  if (initial === "hidden") return hidden;
  if (initial === "hidden_until_first_publish") return { ...hidden, awaitingFirstPublish: true };
  if (initial === "selected_when_replacing_selected") {
    return deletesSelectedAgent ? hidden : { mode: "all", collaborationWorkspaceIds: [] };
  }
  return { mode: "selected", collaborationWorkspaceIds: [initial.collaborationWorkspaceId] };
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

/**
 * Why `agent.use` refuses an agent that is available where the caller is (AGENT-USE-1), from
 * the decision of `agent.use` on it: a covering deny refuses any agent, and an agent limited to
 * the right is refused where no row allows it. An agent set to Everyone needs no row.
 */
export function agentUseRefusalOf(
  decision: AccessDecision,
  limited: boolean
): "no_grant" | "denied" | undefined {
  if (decision.allowed) return undefined;
  if (decision.reason === "denied" || decision.reason === "holder_inactive") return "denied";
  return limited ? "no_grant" : undefined;
}

/**
 * A skill as every turn reads it: what the agent is told of it, without its resources. A
 * skill's resources can be large, such as the product docs of `platform-docs`, and are read
 * one skill at a time, when a call asks for them.
 */
export type RuntimeSkill = Omit<SkillConfig, "resources">;

export interface RuntimeAssetSnapshot {
  version: number;
  defaultAgentName?: string;
  agents: AgentConfig[];
  skills: RuntimeSkill[];
  /**
   * The id and the owner of each agent by its name, where the source read them: what a right
   * on one agent is decided on.
   */
  agentKeys?: ReadonlyMap<string, { id: string; scope: AssetScope }>;
}

export interface ConfigAssetSource {
  /** The agents and skills, read for each turn and each tool call. */
  getSnapshot(): Promise<RuntimeAssetSnapshot>;
  /** One skill whole, with its resources, or nothing where none of the name is active. */
  getSkill(name: string): Promise<SkillConfig | undefined>;
  /**
   * One skill whole with the number of its active revision, read in one read, or nothing where
   * none of the name is active. What a workspace command records of the skills it mounts.
   */
  getSkillRevision(name: string): Promise<{ skill: SkillConfig; revision: number } | undefined>;
}

export interface ConfigAssetRecord {
  appAvailability?: AppAvailability;
  id: string;
  clientInstanceId: ClientInstanceId;
  kind: ConfigAssetKind;
  name: string;
  /** The owner. */
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
  /** Where the active revision came from, where its write said so. */
  revisionOrigin?: ConfigAssetRevisionOrigin;
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
  /**
   * The name a person gave the asset in the interface. The store reads it into the `title` of
   * `config` and `publishedConfig`, over what each revision carries, so every reader of a title
   * reads it; no write of a revision changes it. Absent where no person named the asset.
   */
  personTitle?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a revision came from, where it was not written as it stands: the approval that applied
 * it, or the Page whose files it is a copy of. The newest revision of an App that names a Page
 * is how the App remembers the Page it is updated from: the one it was saved from, or one it
 * was linked to later.
 */
export type ConfigAssetRevisionOrigin =
  | { kind: "approval_request"; requestId: string; summary: string }
  | {
      kind: "page";
      conversationId: string;
      pageId: string;
      /** The number of the Page revision the files were copied from. */
      fileSetNumber: number;
      /** The agent of that conversation saved the Page into the asset, not a person's step. */
      byAgent?: true;
      /** The saving agent’s display name at the time of the save. */
      agentDisplayName?: string;
    }
  /** An agent's tool call in the conversation wrote the revision, for the person it acts for. */
  | { kind: "agent_run"; conversationId: string; agentDisplayName?: string };

/** An asset whose Page is a given one, with who wrote it from that Page last. */
export interface ConfigAssetFromPage {
  asset: ConfigAssetRecord;
  savedBy: AuditActor | null;
}

export interface ConfigAssetRevisionRecord {
  id: string;
  assetId: string;
  clientInstanceId: ClientInstanceId;
  revision: number;
  operation: (typeof CONFIG_ASSET_CHANGE_OPERATIONS)[number];
  config: JsonObject | null;
  /** The immutable file set of the revision, for a kind whose revisions hold files. */
  fileSetId?: FileSetId;
  /** The commit the revision names and its tree, for an asset whose content is a repository. */
  commit?: string;
  tree?: string;
  actor: AuditActor | null;
  origin?: ConfigAssetRevisionOrigin;
  globalVersion: number;
  createdAt: string;
}

/**
 * One publish of a `draft_published` asset: the revision it made live, numbered from 1 per
 * asset. A way back to an earlier revision is a publication of its own. Members count these,
 * never revisions.
 */
export interface ConfigAssetPublicationRecord {
  assetId: string;
  number: number;
  revision: number;
  /** Absent where it is not known, as for the publications the migration wrote. */
  actor: AuditActor | null;
  /** Absent when the historical publish time is unknown. */
  publishedAt?: string;
  note?: string;
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
  kind: (typeof ASSET_REPO_BUNDLE_KINDS)[number];
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
  /**
   * `pending` until the transaction that writes the revision made the bundle part of the
   * repository. `swept` once the save was given up: it cannot be finished or tried again, and
   * its object is removed.
   */
  state: "pending" | "live" | "swept";
  /**
   * The time the commit of the save carries, in whole seconds. It is set once, so every
   * attempt of the run builds the same commit from the same files.
   */
  savedAt: string;
  /** The bundle the save named, once it did. */
  bundle?: AssetRepoSaveBundle;
  /** What the save commits, where a worker builds its commit. */
  request?: AssetRepoCommitRequest;
  /** How the commit of the save ended, once it did. */
  result?: AssetRepoCommitResult;
}

/** One file of the folder a save commits: where its bytes are and what they were. */
export interface AssetRepoSourceFile {
  path: string;
  objectKey: string;
  byteSize: number;
  /** The SHA-256 of the bytes, in lower-case hex. */
  checksum: string;
}

/**
 * What a save asks of the worker that reaches the sandbox: the files of the folder as they
 * were when the save began, the commit they were written from and who the ledger names as
 * the author. It holds no bytes. The time of the commit is the save's, unless it names one.
 */
export interface AssetRepoCommitRequest {
  limits?: {
    fileBytes: number;
    files: number;
    treeBytes: number;
    historyBytes: number;
    settingPrefix: string;
  };
  /** The store the files lie in: the `files` store or the one of the Execution Workspaces. */
  store: "files" | "workspaces";
  files: AssetRepoSourceFile[];
  /** The commit the folder was written from. `null` for the first commit of a repository. */
  baseCommit: string | null;
  /** The opaque id of the user. */
  author: string;
  /** One line, made by the caller from what the ledger knows. */
  message: string;
  /**
   * The time the commit carries, in whole seconds since the epoch, where it is not the time of
   * the save: the adoption of a revision commits at the time the revision was written.
   */
  time?: number;
}

/**
 * How the commit of a save ended. `committed` says the bundle is named on the pending row and
 * its object is put: the write of the revision can name it. `refused` is what the command or
 * the worker found wrong with the files or the repository, and a second attempt with the same
 * files ends the same way. `failed` is anything else, and the save may be tried again.
 */
export type AssetRepoCommitResult =
  | {
      status: "committed";
      commit: string;
      tree: string;
      files: number;
      bundle: Pick<AssetRepoSaveBundle, "objectKey" | "sha256" | "bytes">;
    }
  | { status: "refused"; code: string; path?: string; message: string }
  | {
      status: "failed";
      reason: "no_worker" | "timeout" | "stopped" | "command_missing" | "crashed" | "store";
      message: string;
    };

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
   * `null` and stands on `baseCommit` otherwise. A save the sweeper gave up is refused.
   */
  operationRunId: OperationRunId;
  /**
   * The object this attempt of the save put: its key, hash and size. The write is refused
   * unless the pending row names exactly this object and the store holds it at this size.
   */
  bundle: Pick<AssetRepoSaveBundle, "objectKey" | "sha256" | "bytes">;
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
      /** Existing agents save to their separate shared draft, atomically with the batch. */
      agentDraft?: {
        expectedDraftRevision: number | null;
        author: import("./agent-proposals").AgentDraftAuthor;
      };
      /** Consume precisely this pending draft in the same transaction as its live revision. */
      agentPublish?: number;
      /** Approved skill attachment/detachment is carried into a pending draft. */
      agentSkillChange?: { name: string; attached: boolean };
      /**
       * Tools given to the live agent (`agents.give_tools`): the write is the live revision, and
       * a pending draft keeps its content and author, gains these tools and moves onto it.
       */
      agentToolsGiven?: readonly string[];
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
  appAvailability?: AppAvailability;
  id: string;
  kind: ConfigAssetKind;
  name: string;
  scope: AssetScope;
  /** Whether the published pointer names a revision. Told where a page of a list is read. */
  published?: boolean;
}

/** The definitions a title is read from: the active revision, and the published one if any. */
export interface ConfigAssetTitleSource {
  active?: JsonObject;
  published?: JsonObject;
}

export interface ConfigAssetStore {
  getConfigAssetState(input: { clientInstanceId: ClientInstanceId }): Promise<ConfigAssetState>;
  listActiveConfigAssets(input: {
    clientInstanceId: ClientInstanceId;
    kind?: ConfigAssetKind;
    /** Exclusive byte-order name cursor when reading one kind. */
    afterName?: string;
    /** At most this many active definitions; omitted by full-snapshot readers. */
    limit?: number;
    /** Only assets whose name starts with this text. */
    namePrefix?: string;
    /**
     * Skills without their `resources`, left out by the store before they are read: what the
     * runtime snapshot reads. `getConfigAsset` reads one skill whole.
     */
    withoutSkillResources?: boolean;
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
    /** Only assets whose name starts with this text. */
    namePrefix?: string;
    /**
     * Only assets whose name or title contains `contains`, whatever the case. The title is the
     * kind's, so the store reads the revisions of an asset whose name does not match and asks
     * `titleOf` for the title its caller is shown.
     */
    text?: {
      contains: string;
      titleOf(asset: ConfigAssetKey, revisions: ConfigAssetTitleSource): string;
    };
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
    /** Exclusive name cursor in the same byte order as the list. */
    afterName?: string;
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
  /**
   * The active assets of a kind whose Page is this one, the earliest first: the Page named by
   * the newest of an asset's revisions that names one. One read of at most `limit` rows. It
   * walks the revisions of every active asset of the kind from the newest back to the first
   * that names a Page, so its cost grows with the assets of the kind on the instance, and
   * with the revisions of those that were never written from a Page.
   */
  listConfigAssetsFromPage(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    pageId: string;
    limit: number;
    /** How many of them to pass over first: the next read of a caller who reads in parts. */
    offset?: number;
  }): Promise<ConfigAssetFromPage[]>;
  /** The Page an asset is updated from: the origin of its newest revision that names one. */
  getConfigAssetPageOrigin(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<Extract<ConfigAssetRevisionOrigin, { kind: "page" }> | undefined>;
  /** The revisions of one asset, oldest first unless `newestFirst` is set. */
  listConfigAssetRevisions(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    page?: StorePage;
    /** Orders the revisions from the latest down, and reads `page.after` in that order. */
    newestFirst?: boolean;
  }): Promise<ConfigAssetRevisionRecord[]>;
  /** The publications of one asset, the newest first: the first is the live one while it is. */
  listConfigAssetPublications(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    /** Reads `page.after` as a publication number. */
    page?: StorePage;
  }): Promise<ConfigAssetPublicationRecord[]>;
  /** One revision of one asset, read without the others. */
  getConfigAssetRevision(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    revision: number;
  }): Promise<ConfigAssetRevisionRecord | undefined>;
  /**
   * One revision of one asset by its id: what a reader holds that kept the id of the revision
   * it started on, such as a Workflow Run. A revision of another asset is not answered.
   */
  getConfigAssetRevisionById(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    revisionId: string;
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
    origin?: ConfigAssetRevisionOrigin;
    /** Defaults to `all`. */
    initialAgentAvailability?: InitialAgentAvailability;
    mutations: ConfigAssetMutation[];
    /**
     * The size of an object of the `files` store, or nothing where there is none. A batch with
     * a repository write needs it: the bundle of the write must be in the store before it
     * becomes part of the repository.
     */
    repositoryObjectSize?(objectKey: string): Promise<number | undefined>;
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
    draftRevisions?: Record<string, number>;
    /** The id of each asset that has an entry in `revisions`, keyed the same way. */
    assetIds: Record<string, string>;
  }>;
  /**
   * Moves the published pointer of one asset to the revision of that number and records the
   * publication, numbered after the asset's last, in one transaction. Refuses a number the
   * asset has no content for with `NOT_FOUND`.
   */
  publishConfigAssetRevision(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    /** Who published, as the publication names them; absent for a release's own publish. */
    actor?: AuditActor;
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
    /** The audience changes atomically with the live pointer. Apps only. */
    audience?: AppAudience;
    /** With self: the selecting person's personal workspace. */
    audienceWorkspaceId?: CollaborationWorkspaceId;
    /** The live state whose reach was reviewed; rechecked under the asset row lock. */
    appPublishReview?: {
      liveRevisionId: string | null;
      liveAudience: AppAvailability;
      contentWidens: boolean;
    };
  }): Promise<{
    assetId: string;
    revision: number;
    publishWidens?: boolean;
    /** The number of the publication this publish recorded. */
    publication: number;
    /** The number the pointer named before, absent on the first publish. */
    replacedRevision?: number;
    fileSetId?: FileSetId;
  }>;
  /**
   * Takes the published pointer away: nothing of the asset is served until a revision is
   * published again, and the draft stays as it is. Refuses with `nothing_published` where
   * nothing is published. Answers the revision that was published.
   */
  unpublishConfigAsset(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    /** The asset whose right was checked, as in `publishConfigAssetRevision`. */
    assetId: string;
  }): Promise<{ revision: number }>;
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
   * Gives an active asset the name a person chose (`personTitle`), over the title of every
   * revision. Changes no revision and no published pointer: what people read changes at once,
   * draft and published alike. Answers the asset as it is after. Refuses with `NOT_FOUND`
   * where none of the name is active, and with `CONFLICT` where it is no longer `assetId`.
   */
  setConfigAssetPersonTitle(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
    /** The asset whose right was checked, as in `publishConfigAssetRevision`. */
    assetId: string;
    title: string;
    updatedAt: string;
  }): Promise<ConfigAssetRecord | undefined>;
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
   * The assets of one kind, in every scope and of every status, of which a revision names no
   * commit: what the adoption of their repositories walks (WF-GIT-2), in the order of their
   * ids, after `after`. With `name`, only the asset of that name.
   */
  listAssetsWithoutCommits(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name?: string;
    after?: string;
    limit: number;
  }): Promise<{ id: string; name: string }[]>;
  /**
   * Fills a revision of an asset that was written before its kind had a repository, under the
   * lock every write of an asset takes: its file set where it names none, and its commit and
   * tree. The commit stands on the commit of the revision before it, which must be
   * `repository.baseCommit`; the first revision starts the repository. The pending bundle of
   * the save becomes part of the repository as for any write (`insertRepoWrites`). A deletion
   * names no new commit and keeps the one before it, as its tombstone does. A revision that
   * names this commit already is answered as it is. Answers the file set the revision names.
   */
  fillAssetRepoRevision(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    revision: number;
    fileSetId?: FileSetId;
    repository?: AssetRepoWrite;
    /** As in `applyConfigAssetMutations`. Asked for the bundle of `repository`. */
    repositoryObjectSize?(objectKey: string): Promise<number | undefined>;
  }): Promise<{ fileSetId?: FileSetId }>;
  /**
   * Starts a save, or finds the one the Operation Run started before. The first call writes a
   * pending row with the time of the save; every later call of the run answers that row, so a
   * second attempt commits with the same time. The asset need not exist yet. A save that is
   * answered as `swept` is over: the run saves nothing more.
   *
   * The row is written at once, for itself. This, naming the bundle and sweeping are refused
   * on the stores of a transaction, where a rollback would take the row and leave the object.
   */
  beginAssetRepoSave(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    operationRunId: OperationRunId;
    /** Kept by the call that writes the row. A later call of the run does not replace it. */
    request?: AssetRepoCommitRequest;
  }): Promise<AssetRepoSave>;
  /** The save of an Operation Run, where it began one. */
  getAssetRepoSave(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    operationRunId: OperationRunId;
  }): Promise<AssetRepoSave | undefined>;
  /**
   * Writes how the commit of a pending save ended, once: a save that has a result keeps it,
   * and `false` says so. `result: null` takes a `failed` result away, so that the run can try
   * again; a result of another kind stays.
   */
  answerAssetRepoSave(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    operationRunId: OperationRunId;
    result: AssetRepoCommitResult | null;
  }): Promise<boolean>;
  /**
   * Names the bundle of a pending save, before its object is put, so no object is in the
   * store that no row names. A save names one bundle and keeps it: naming the same again, in
   * every field, changes nothing, and anything else is refused with the reason
   * `pending_bundle_differs` and the key that is named. An attempt that packed the commit
   * differently puts nothing and ends there. A save that is not pending any more is refused
   * with the reason `save_not_pending`.
   */
  nameAssetRepoSaveBundle(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    operationRunId: OperationRunId;
    bundle: AssetRepoSaveBundle;
  }): Promise<void>;
  /**
   * Gives up the saves that are still pending and were begun before `olderThan`, and the rows
   * of assets that are not there any more, and removes the objects of rows that were given up.
   *
   * It first makes those rows `swept` and commits that. Only then is `removeObject` called
   * for the object of each swept row, so a row that can still become part of a repository
   * always has its object, whatever fails afterwards. A swept row stays until it was swept
   * before `olderThan`, and its object is removed on every pass until then: an upload that
   * was still on its way when the row was swept is removed by a later pass. A removal that
   * fails leaves its row for the next pass, and the first failure is thrown once every row
   * was tried.
   */
  sweepAssetRepoSaves(input: {
    olderThan: Date;
    limit: number;
    removeObject(object: {
      clientInstanceId: ClientInstanceId;
      assetId: string;
      objectKey: string;
    }): Promise<void>;
  }): Promise<{ swept: number; removed: number }>;
  /** The checkout a folder of a conversation is, where it is one. */
  getAssetCheckout(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    folder: string;
  }): Promise<AssetCheckout | undefined>;
  /**
   * Unsaved working copies of the current draft in chats active after `activeAfter`.
   * Names only active co-members of the asset's workspace, excluding the viewer; no chat data.
   * A save closes the hint even though it advances the checkout's base.
   */
  listOpenAssetCheckouts(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    viewerId: string;
    activeAfter: Date;
  }): Promise<{ displayLabel: string; since: string }[]>;
  /** Binds a loaded working copy to its immutable base revision; moves no asset pointer. */
  setAssetCheckout(input: AssetCheckout & { clientInstanceId: ClientInstanceId }): Promise<void>;
  /** Availability of active assets of one kind that have a record, keyed by name. */
  listAgentAvailability(input: {
    clientInstanceId: ClientInstanceId;
    /** Only this agent's record, for a read of one agent that must not load every other. */
    agentName?: string;
    /** Defaults to agent for existing callers; all available asset kinds share the table. */
    kind?: string;
  }): Promise<Map<string, AgentAvailability>>;
  /**
   * Whether the active agent of this name still awaits its first publish: it was made hidden
   * until then, and nothing has written its availability since (WS-PUB-1b).
   */
  agentAwaitsFirstPublish(input: {
    clientInstanceId: ClientInstanceId;
    agentName: string;
  }): Promise<boolean>;
  /**
   * Rejects hiding the instance default agent, which must stay `all`. Moves the version of the
   * asset set in the same transaction, as every other change of what a run sees of it does.
   */
  setAgentAvailability(input: {
    clientInstanceId: ClientInstanceId;
    agentName: string;
    kind?: string;
    expectedRevision?: number;
    availability: AgentAvailability;
    /**
     * What the change was decided against. Given, the store compares under the lock of the
     * change and throws `CONFLICT` where the name is another asset's by now, or the stored
     * availability is another one. `null` expects that none is stored.
     */
    expectedAssetId?: string;
    expectedAvailability?: AgentAvailability | null;
    /**
     * Given, the store throws `CONFLICT` unless the agent still awaits its first publish. Every
     * save of an availability clears that mark, an unchanged one too, so an admin's explicit
     * "nowhere" wins over a later approval.
     */
    expectAwaitingFirstPublish?: true;
    /**
     * Keeps the mark where the compare finds the availability unchanged: a publish's own check
     * of what its publisher reviewed is no decision about where the agent is offered.
     */
    keepAwaitingFirstPublish?: true;
  }): Promise<AgentAvailability>;
  /** The names of the active agents only holders of `agent.use` may use (AGENT-USE-1). */
  listAgentUseLimits(input: {
    clientInstanceId: ClientInstanceId;
    /** Only this agent, for a read of one agent that must not load every other. */
    agentName?: string;
  }): Promise<ReadonlySet<string>>;
  /**
   * Limits one active agent to holders of `agent.use`, or opens it to everyone where it is
   * available. `expectedAssetId` refuses with `CONFLICT` where the name is another asset's.
   */
  setAgentUse(input: {
    clientInstanceId: ClientInstanceId;
    agentName: string;
    use: AgentUse;
    expectedAssetId?: string;
  }): Promise<AgentUse>;
  /**
   * The active skills of one person's Personal Workspace, each with whether the person uses it
   * in their own chats with every agent (SCOPE-MYCHATS). Nobody else's skill is in it: the
   * owner is read from the workspace, never from the caller's word.
   */
  listPersonalChatSkills(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
  }): Promise<PersonalChatSkill[]>;
  /**
   * Switches one skill of the person's Personal Workspace on or off for their own chats.
   * Throws `NOT_FOUND` for any other skill, one of another person's included.
   */
  setPersonalChatSkill(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
    skillName: string;
    inMyChats: boolean;
  }): Promise<PersonalChatSkill>;
  /**
   * Gives the named assets a new owner, all of them or none (SHARE-1): one transaction, under
   * the lock every write of the set takes, sets their owning workspace and nothing else. Their
   * ids, names, revisions, pointers, drafts, availability and grants stay; nothing is copied.
   * Each asset must still be active, owned by `from` and at the revisions it was planned at,
   * else the move is refused with `CONFLICT` and the reason `asset_moved_meanwhile`.
   */
  moveConfigAssets(input: {
    clientInstanceId: ClientInstanceId;
    to: AssetScope;
    assets: readonly {
      id: string;
      from: AssetScope;
      activeRevisionId: string;
      publishedRevisionId?: string;
    }[];
  }): Promise<{ version: number }>;
}

/** A skill of a person's Personal Workspace, and whether their own chats use it. */
export interface PersonalChatSkill {
  name: string;
  inMyChats: boolean;
}
