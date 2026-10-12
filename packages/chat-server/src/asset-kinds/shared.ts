import type {
  ActorAccess,
  ConfigAssetKind,
  JsonObject,
  Namespace,
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
  /** Throws `FORBIDDEN` when the instance's editing policy refuses an interactive delete. */
  assertInteractiveDeleteAllowed(): void;
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
