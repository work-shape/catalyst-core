import type {
  ActorAccess,
  ConfigAssetKind,
  Namespace,
  RegisteredAssetKind
} from "@vivd-catalyst/core";

/**
 * The agents and skills of an instance as the export and the release sync carry them. It is
 * the format of those two and of nothing else: every other path holds definitions by kind id.
 */
export interface ConfigAssetBundle<Definition = unknown> {
  defaultAgentName?: string;
  agents: Definition[];
  skills: Definition[];
}

/** What an agent or skill definition may refer to on this instance. */
export interface ConfigAssetValidationRefs {
  modelProviderIds: string[];
  modelBindingIds: string[];
  modelBindings: Array<{ id: string; model: string }>;
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
   * Where the release sync's bundle carries this kind. A kind without a slot is not part of
   * that bundle: it is read and written through the asset operations alone.
   */
  readonly bundle?: {
    definitions<Definition>(bundle: ConfigAssetBundle<Definition>): Definition[];
    withDefinitions<Definition>(
      bundle: ConfigAssetBundle<Definition>,
      definitions: Definition[]
    ): ConfigAssetBundle<Definition>;
  };
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
  /** Throws `FORBIDDEN` when the instance's editing policy refuses an interactive delete. */
  assertInteractiveDeleteAllowed(): void;
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
