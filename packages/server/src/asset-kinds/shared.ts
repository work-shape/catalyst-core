import type { StoredAgentReferences } from "@work-shape/catalyst-config-schema";
import type {
  ActorAccess,
  AssetScope,
  AuditActor,
  ClientInstanceId,
  ConfigAssetKind,
  CapabilityAssetKindChecks,
  ConfigAssetRecord,
  FileSet,
  JsonObject,
  LocaleCode,
  OperationEffect,
  PlatformStores,
  RegisteredAssetKind,
  ToolPresentation,
  WorkflowAccountRights
} from "@work-shape/catalyst-core";

/** What a kind's `withinWrite` leaves to do once the transaction ended. */
export interface AssetWriteFollowUp {
  /** Called once after the commit. Never throws. */
  committed(): Promise<void>;
  /** Called where the transaction rolled back: nothing of it happened. */
  rolledBack(): void;
}

/** What an agent or skill definition may refer to on this instance. */
export interface ConfigAssetValidationRefs extends StoredAgentReferences {
  modelProviderIds: string[];
  modelBindingIds: string[];
  modelBindings: Array<{ id: string; model: string; label?: string; fallback?: string }>;
  fastModeModelBindingIds: string[];
  reasoningEfforts: string[];
  enabledToolNames: string[];
  /** The full registry, including tools this instance does not enable. */
  registeredToolNames?: readonly string[];
}

/**
 * One tool an agent of the instance can be given, with what it tells people. `effect` is missing
 * only for a tool the instance enables and no code registers.
 */
export interface AgentToolReference extends ToolPresentation {
  name: string;
  effect?: OperationEffect;
}

/** What the platform tells its agents before their own instructions. */
export interface PlatformInstructions {
  /** The rules at the head of every agent's system prompt. */
  rules: string;
  /** How the platform works, for an agent that holds one of `toolNames`. */
  orientation: string;
  /** The platform's tools: an agent whose definition lists one of them holds them. */
  toolNames: readonly string[];
}

/**
 * What a revision reaches that its live revision does not, as the person who approves its
 * publish reads it. Read from the two stored configs alone.
 */
export interface PublishReach {
  /**
   * The actions or the steps that call an operation, each new or changed against the live
   * revision. `effect` where the definition says it; otherwise the operation's is read.
   */
  calls: readonly {
    label: string;
    operation?: string;
    effect?: OperationEffect;
    change: "new" | "changed";
  }[];
  /** Outside hosts the revision calls and the live one does not. */
  hostsAdded: readonly string[];
  /** The Connections the revision names. */
  connections: readonly string[];
  /** The Data Stores the revision uses, with the level it needs of each. */
  dataStores: readonly { name: string; minSchema?: number }[];
  /** The service principal a run of the revision acts as. */
  runAs?: string;
}

/** The operation a write of an asset arrives through. */
export type AssetWriteSurface = "put" | "delete" | "revert" | "sync";

/**
 * The names a question shows in place of ids: of a user, of a Shared Workspace, and of an asset
 * a definition names.
 */
export interface AddresseeNames {
  /** The user's name, or nothing for an id that names no user. */
  user(id: string): Promise<string | undefined>;
  /** The Shared Workspace's name, or nothing for an id that names none. */
  workspace(id: string): Promise<string | undefined>;
  /**
   * The title people read of an asset, by its kind and name, or nothing where none exists or
   * the reader may neither read nor use it. The name in the definition is then shown.
   */
  asset?(kind: string, name: string): Promise<string | undefined>;
}

/**
 * A registered kind with what the config asset workflow asks of it. Everything the workflow
 * does differently for one kind is answered here, by that kind's registration.
 */
/** What a publish question is asked about, for a reader in `locale`. */
interface PublishQuestionInput {
  assetId: string;
  scope: AssetScope;
  config: unknown;
  locale: LocaleCode;
  names: AddresseeNames;
}

export interface WorkflowAssetKind
  extends RegisteredAssetKind<ConfigAssetKind>, CapabilityAssetKindChecks {
  /**
   * A release carries this kind: the release holder writes it through a sync, and the overview
   * of the instance lists it. A kind without it is read and written by its own rights alone.
   */
  readonly inRelease?: true;
  /** The instance keeps one asset of this kind as its default: the first one, until changed. */
  readonly holdsInstanceDefault: boolean;
  /** An asset of this kind is usable only in the workspaces its availability names. */
  readonly hasWorkspaceAvailability: boolean;
  /** Resource use can operate on data without opening its published settings. */
  readonly useOpensPublishedRevision?: false;
  /** The account label for this revision, including a Workflow's planned own account. No ids or internal names. */
  readRunsAs?(config: JsonObject): Promise<string | undefined>;
  /** The Workflow schedule, using the engine's cron and clock. */
  readSchedule?(config: JsonObject): { timeZone: string; nextDueAt?: string };
  /** Workspace targets an instance-owned source may name; every Workflow call checks its principal. */
  readonly crossOwnerReferences?: readonly string[];
  /** Adjusts what an interactive save sends before it is validated. */
  prepareInteractiveUpsert(input: {
    current: unknown;
    next: Record<string, unknown>;
    /**
     * The principal who writes, where the save has one: a put and a validate. A kind that
     * records who is accountable for a new asset reads it.
     */
    principalId?: string;
  }): Record<string, unknown>;
  /**
   * What a revert stores of an earlier revision, for a kind whose server decides fields that
   * an earlier revision may hold differently: those stay as they are now. Without it the
   * revision is stored as it was.
   */
  prepareRevert?(input: {
    current: unknown;
    restored: Record<string, unknown>;
    principalId: string;
  }): Record<string, unknown>;
  /**
   * The right an interactive save needs beside the kind's write right and its caller lacks,
   * where there is one. It is asked of what the caller sent, before the policy is asked about
   * the call. `assertInteractiveUpsertAllowed` asks the same of the validated definition.
   */
  missingUpsertRight(input: {
    access: ActorAccess;
    name: string;
    /** The stored definition, or undefined for a new asset. */
    current: unknown;
    next: unknown;
    /** A list names the model bindings the agent may use (`listsModelBindings`). */
    modelBindingsListed: boolean;
  }): string | undefined;
  /** Throws `FORBIDDEN` when the instance's editing policy refuses this interactive save. */
  assertInteractiveUpsertAllowed(input: {
    access: ActorAccess;
    surface: AssetWriteSurface;
    name: string;
    /** The stored definition, or undefined for a new asset. */
    current: unknown;
    /** The validated definition. */
    next: unknown;
    modelBindingsListed: boolean;
  }): void;
  /**
   * What every write keeps of the stored definition, a release's and a revert included: the
   * fields only the platform writes, such as what a shipped agent was shipped as. It throws
   * where no write but the platform's may create the asset.
   */
  keepStored?(input: { current: unknown; next: Record<string, unknown> }): Record<string, unknown>;
  /** Throws where the stored asset may not be deleted, by a release either. */
  assertStoredDeletable?(input: { current: unknown }): void;
  /**
   * What a revision reaches beside its live revision, for the review of a held publish. A kind
   * whose publish no guardrail holds leaves it out.
   */
  /**
   * Unrecorded draft review lines; accounts and source boundaries must never enter runs. They
   * are written in `locale`, the reader's language, and name people and workspaces by name.
   */
  publishQuestion?(input: PublishQuestionInput): Promise<string[]>;
  /**
   * In place of `publishQuestion`, of a kind whose publish confirms a count and cost (a
   * Knowledge Base): the lines, and the confirmation its publish passes as `confirmProcessing`.
   */
  publishReview?(input: PublishQuestionInput): Promise<{
    lines: string[];
    confirmation?: string;
    /**
     * Of a publish that processes contents again: the count and cost of the sentence at
     * index `line` of `lines`, as fields a client words in the reader's language.
     */
    processing?: {
      count: number;
      line: number;
      cost:
        | { kind: "none" }
        | { kind: "estimate"; min: number; max: number; currency: string }
        | { kind: "unavailable" };
    };
  }>;
  publishReach?(next: JsonObject, live: JsonObject | undefined): PublishReach;
  /**
   * The rights the accounts a publish of the asset's newest revision runs as need, by the
   * asset's name: its own and each child's. Nothing where no asset has the name. The check of
   * the publish asks the same list. With `config`, the revision of that config is the one asked
   * about in place of the newest: what a publish review shows.
   */
  principalRights?(name: string, config?: JsonObject): Promise<WorkflowAccountRights[] | undefined>;
  /**
   * What a check of a definition that holds says beside its issues: a warning refuses nothing.
   * Asked by `assets.validate` only, with what is stored.
   */
  validationWarnings?(input: {
    clientInstanceId: ClientInstanceId;
    definition: unknown;
    stores: PlatformStores;
  }): Promise<{ code: string; message: string }[]>;
  /** Throws `FORBIDDEN` when the instance's editing policy refuses an interactive delete. */
  assertInteractiveDeleteAllowed(input: { surface: AssetWriteSurface }): void;
  /**
   * Throws where another asset still needs this one and nothing checks that reference when
   * the other is written: asked of a delete with the assets as they are stored, each with its
   * draft and, where it has one, its published config.
   */
  assertRemovable?(input: {
    name: string;
    assets(kind: string): Promise<readonly ConfigAssetRecord[]>;
  }): Promise<void>;
  /**
   * What a delete or an unpublish of this asset answers beside its result: one warning for
   * each live asset that calls it and stops working without it. A warning and never a refusal:
   * whoever takes the asset back decides, and is told what it breaks.
   */
  liveCallerWarnings?(input: {
    clientInstanceId: ClientInstanceId;
    name: string;
    stores: PlatformStores;
    /** What the caller may do: a warning names only what the caller may read. */
    access: ActorAccess;
  }): Promise<{ code: string; message: string }[]>;
  /**
   * What a write or delete of a config revision must do in the same transaction: asked after
   * the revision was written and before the commit, with the transaction's stores. What it
   * throws refuses the write. It answers what to do once the transaction committed, or
   * nothing. Asked of `assets.put`, revert and delete; a kind that brings it has those writes
   * made in one transaction with it.
   */
  withinWrite?(input: {
    clientInstanceId: ClientInstanceId;
    name: string;
    /** The asset written, where it existed before the write. */
    assetId: string | undefined;
    /**
     * The asset a put creates again after its delete, under the same id. A revert that
     * restores a deleted asset names none: it brings back what was deleted.
     */
    createdAgainId?: string;
    /** The config before the write and its revision, where the asset was active. */
    previous: unknown;
    previousRevision: number | undefined;
    /** The config written, or nothing for a delete. */
    config: JsonObject | undefined;
    actor: AuditActor;
    correlationId: string;
    stores: PlatformStores;
  }): Promise<AssetWriteFollowUp | undefined>;
  /**
   * What a write of a config revision does beside storing it, called once the write is
   * committed, with the stores of the instance. A failure is logged and the write stands, so
   * what it does is something a later write or start repairs.
   */
  afterWrite?(input: {
    clientInstanceId: ClientInstanceId;
    name: string;
    /** The config before the write, where the asset was active. */
    previous: unknown;
    config: JsonObject;
    stores: PlatformStores;
  }): Promise<void>;
  /**
   * The config a revision holds, made from the manifest its build validated. A kind whose
   * revisions hold files brings it: only the kind knows what its config is beside the manifest.
   */
  configOfFiles?(input: {
    name: string;
    manifest: JsonObject;
    /** The config of the draft the write replaces, where there is one. */
    current?: JsonObject;
  }): Record<string, unknown>;
  /**
   * Reads the source files of a write into the manifest of their file set, for a kind whose
   * files are not built as a Page: nothing is bundled, and the set holds the source files
   * alone. Throws `VALIDATION_FAILED` for files it refuses.
   */
  manifestOfFiles?(files: readonly { path: string; bytes: Uint8Array }[]): JsonObject;
  /**
   * Set by a kind whose revision is a config and may hold files beside it: the config stays
   * the one place its text is read from, and the files the config cannot hold are kept in a
   * file set the revision names. Such a kind is written as its config or as its whole folder
   * of files, and is read as either. A write of the config alone leaves the other files of
   * the asset where they are.
   */
  readonly revisionFiles?: {
    /** The file of the folder that every write of files carries. */
    manifestFile: string;
    /**
     * Reads the folder of one write: the config it makes, and the paths of the files the
     * config does not hold. Throws `VALIDATION_FAILED` for a set or a file it refuses.
     */
    read(
      name: string,
      files: readonly { path: string; bytes: Uint8Array }[]
    ): { config: Record<string, unknown>; extras: string[] };
    /** What the file set of a revision names as its manifest. */
    manifestOf(extras: readonly string[]): JsonObject;
    /**
     * The config with the index of the files of its file set that it does not hold itself,
     * and without one where there is none. What a caller sent as the index is not read.
     */
    indexed(config: JsonObject, fileSet: FileSet | undefined): JsonObject;
    /**
     * What a write of the config alone keeps of the revision before it: the index of the
     * files where that revision has a file set, and whatever else of its config such a write
     * cannot know to send. Throws `VALIDATION_FAILED` where the folder the write leaves is one
     * a write of the whole folder is refused for.
     */
    carried(config: JsonObject, before: unknown, beforeHasFiles: boolean): JsonObject;
    /** The files a config holds itself, as a read of the folder answers them. */
    filesOfConfig(config: unknown): { path: string; bytes: Uint8Array }[];
    /** Whether stored bytes say what the config says at their path. */
    matchesConfig(config: unknown, file: { path: string; bytes: Uint8Array }): boolean;
  };
  /**
   * What the answer of a write says of a definition that was written and that its caller
   * should know: each a warning with a code, none a refusal.
   */
  writeWarnings?(
    definition: unknown,
    files?: readonly { path: string; bytes: Uint8Array }[]
  ): { code: string; message: string }[];
  /** Withdraw live bindings in the pointer's transaction, preserving historical run data. */
  onUnpublish?(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    published?: JsonObject;
    stores: PlatformStores;
  }): Promise<void>;
  /**
   * What a delete does beside removing the asset. For a kind whose revisions hold files it is
   * called in the transaction that removes the asset. For a kind whose revisions are a config
   * it is called once the delete is committed, with the stores of the instance: there a
   * failure is logged and the delete stands, so what it does is something a later look
   * repairs.
   */
  onRemove?(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    name?: string;
    /** The config that was published until the delete, where one was. */
    published?: JsonObject;
    stores: PlatformStores;
  }): Promise<void>;
  /**
   * What the deletion of a workspace does to the kind's assets in it before the store removes
   * what the workspace owns: the kind's own delete of each, which the store then requires. A
   * kind without it loses its assets with the workspace. It is asked on every pass of the
   * deletion with the assets still active, one page at a time; a throw leaves the rest of the
   * deletion to the next pass.
   */
  retireWithWorkspace?(input: {
    clientInstanceId: ClientInstanceId;
    assets: readonly ConfigAssetRecord[];
    stores: PlatformStores;
    actor: AuditActor;
    correlationId: string;
  }): Promise<void>;
}

export function readDefinitionField(definition: unknown, field: string): unknown {
  if (typeof definition !== "object" || definition === null || !(field in definition)) {
    return undefined;
  }
  return Object.entries(definition).find(([key]) => key === field)?.[1];
}

export function readDefinitionName(definition: unknown): string | undefined {
  const name = readDefinitionField(definition, "name");
  return typeof name === "string" ? name : undefined;
}

/** Object key order carries no meaning: a JSON store may return keys in another order. */
export function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(withSortedKeys(left)) === JSON.stringify(withSortedKeys(right));
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, withSortedKeys(entry)])
  );
}
