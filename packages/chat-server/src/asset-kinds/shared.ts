import type {
  ActorAccess,
  AssetScope,
  AuthenticatedIdentity,
  ClientInstanceId,
  ConfigAssetKind,
  ConfigAssetRecord,
  FileSet,
  JsonObject,
  Namespace,
  PlatformStores,
  RegisteredAssetKind
} from "@vivd-catalyst/core";

/** What an agent or skill definition may refer to on this instance. */
export interface ConfigAssetValidationRefs {
  modelProviderIds: string[];
  modelBindingIds: string[];
  modelBindings: Array<{ id: string; model: string; label?: string }>;
  fastModeModelBindingIds: string[];
  reasoningEfforts: string[];
  enabledToolNames: string[];
}

/** The operation a write of an asset arrives through. */
export type AssetWriteSurface = "put" | "delete" | "revert" | "sync";

/**
 * A registered kind with what the config asset workflow asks of it. Everything the workflow
 * does differently for one kind is answered here, by that kind's registration.
 */
export interface WorkflowAssetKind extends RegisteredAssetKind<ConfigAssetKind> {
  /**
   * A release carries this kind: the release holder writes it through a sync, and the overview
   * of the instance lists it. A kind without it is read and written by its own rights alone.
   */
  readonly inRelease?: true;
  /** The instance keeps one asset of this kind as its default: the first one, until changed. */
  readonly holdsInstanceDefault: boolean;
  /** An asset of this kind is usable only in the workspaces its availability names. */
  readonly hasWorkspaceAvailability: boolean;
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
    namespaces: readonly Namespace[];
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
    namespaces: readonly Namespace[];
  }): void;
  /**
   * Throws where the stored asset may not be changed through any asset operation, whatever
   * the caller sends and whoever calls: an asset that release config defines. It is asked of
   * what is stored before the write is read, so its refusal comes before every other one.
   */
  assertStoredWritable?(input: { current: unknown }): void;
  /**
   * Throws where this caller may not make this revision the one the asset's users are served,
   * whatever the kind's publish right says: the revision lends something its writer could not
   * give, such as the grants of the service principal a Workflow runs as. It is asked of the
   * revision that becomes live and of who makes it so: on a publish, of the newest revision
   * and of an earlier one alike. Who wrote the revision is not asked. Only a kind with the
   * lifecycle `draft_published` may set it, and the registry refuses any other: there a
   * revision goes live by a publish and by nothing else, and a delete takes the published
   * revision away, so a deleted asset that is written again is a draft.
   */
  authorizeLive?(input: {
    actor: AuthenticatedIdentity;
    access: ActorAccess;
    name: string;
    /** The revision that becomes live. */
    revision: number;
    /** The config of that revision. */
    config: unknown;
  }): void | Promise<void>;
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
     * cannot know to send.
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
  writeWarnings?(definition: unknown): { code: string; message: string }[];
  /**
   * What a publish does beside moving the published pointer, with `stores` bound to the
   * transaction that moves it. A throw refuses the publish and leaves the pointer where it was.
   */
  onPublish?(input: {
    clientInstanceId: ClientInstanceId;
    /** What the caller of the publish may do: a kind asks it for what the revision reaches. */
    access: ActorAccess;
    assetId: string;
    /** The owner of the asset: what it names of other assets is read in this scope. */
    scope: AssetScope;
    revision: number;
    config: JsonObject;
    /** The config that was published until this publish, where one was. */
    replaced?: JsonObject;
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
    /** The config that was published until the delete, where one was. */
    published?: JsonObject;
    stores: PlatformStores;
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
