import { AppError } from "./errors";

/**
 * Every module the product knows. A module is one optional feature with one switch,
 * `modules.<name>.enabled` in release config. A new module adds its name here and registers
 * its definition where its code ships.
 */
export const MODULE_NAMES = [
  "documents",
  "resources",
  "assetManagement",
  "userInvitations"
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

export function isModuleName(value: string): value is ModuleName {
  return MODULE_NAMES.some((name) => name === value);
}

/** What one module contributes. Everything listed here is off when the module is off. */
export interface ModuleDefinition {
  readonly name: ModuleName;
  /** Modules that must be on for this one to be on. Nothing turns them on implicitly. */
  readonly requires?: readonly ModuleName[];
  /** Asset kinds. */
  readonly kinds?: readonly string[];
  /** Operation ids of the API catalog. */
  readonly operations?: readonly string[];
  readonly jobKinds?: readonly string[];
  /** Agent tool names. */
  readonly tools?: readonly string[];
  /** Names of the screens and panels the interface shows for this module. */
  readonly ui?: readonly string[];
}

export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  return Object.freeze({
    name: definition.name,
    requires: frozenList(definition.requires),
    kinds: frozenList(definition.kinds),
    operations: frozenList(definition.operations),
    jobKinds: frozenList(definition.jobKinds),
    tools: frozenList(definition.tools),
    ui: frozenList(definition.ui)
  });
}

/** The switches as release config holds them, by module name. */
export type ModuleSwitches = Readonly<Record<string, { readonly enabled: boolean }>>;

/**
 * Which modules are on for one instance config. The API, every worker and the interface read
 * this and nothing else to decide whether a module is on.
 */
export interface ModuleSnapshot {
  /** Every known module with its state, in the order of `MODULE_NAMES`. */
  readonly modules: readonly ModuleState[];
  isEnabled(name: ModuleName): boolean;
  /**
   * The module that owns the named contribution, when that module is off. Nothing for a
   * contribution of a module that is on and for one no module owns, which is core.
   */
  offModuleOf(contribution: ModuleContribution, name: string): ModuleName | undefined;
}

/** One module as an instance runs it. */
export interface ModuleState {
  readonly name: ModuleName;
  readonly enabled: boolean;
  /** What the module contributes. Missing when this build ships no code for the module. */
  readonly definition?: ModuleDefinition;
}

/** What a module can own that a caller reaches by name. */
export type ModuleContribution = "operation" | "tool" | "jobKind";

const contributionLists = {
  operation: "operations",
  tool: "tools",
  jobKind: "jobKinds"
} as const satisfies Record<ModuleContribution, keyof ModuleDefinition>;

/** The release config key that switches a module. */
export function moduleConfigKey(name: ModuleName): string {
  return `modules.${name}.enabled`;
}

/**
 * The one refusal of everything a module that is off owns. It reads like a missing route,
 * because for this instance the feature does not exist.
 */
export function moduleOffError(module: ModuleName): AppError {
  return new AppError("NOT_FOUND", `Module '${module}' is off on this instance`, {
    reason: "module_off",
    module
  });
}

/** Refuses a call of an operation whose module is off. */
export function requireOperationModuleOn(modules: ModuleSnapshot, operationId: string): void {
  const module = modules.offModuleOf("operation", operationId);
  if (module !== undefined) {
    throw moduleOffError(module);
  }
}

/** The modules whose code this build ships. */
export interface ModuleRegistry {
  readonly modules: readonly ModuleDefinition[];
  get(name: ModuleName): ModuleDefinition | undefined;
  /**
   * Resolves the switches against this registry. Fails on a name the product does not know,
   * on an enabled module this build ships no code for, and on an enabled module whose required
   * module is off. Each message names the module.
   */
  snapshot(switches: ModuleSwitches): ModuleSnapshot;
}

export function createModuleRegistry(definitions: readonly ModuleDefinition[]): ModuleRegistry {
  const byName = new Map<ModuleName, ModuleDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Module '${definition.name}' is registered more than once`
      );
    }
    byName.set(definition.name, defineModule(definition));
  }
  const modules = Object.freeze([...byName.values()]);

  return Object.freeze({
    modules,
    get: (name: ModuleName) => byName.get(name),
    snapshot(switches: ModuleSwitches): ModuleSnapshot {
      const unknown = Object.keys(switches).find((name) => !isModuleName(name));
      if (unknown !== undefined) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Unknown module '${unknown}' under 'modules'. Known modules: ${MODULE_NAMES.join(", ")}`
        );
      }
      const enabled = new Set(MODULE_NAMES.filter((name) => switches[name]?.enabled === true));
      for (const name of enabled) {
        const definition = byName.get(name);
        if (!definition) {
          throw new AppError(
            "VALIDATION_FAILED",
            `Module '${name}' is enabled but this build ships no code for it. Turn 'modules.${name}.enabled' off or add the package that registers it`
          );
        }
        const missing = definition.requires?.find((required) => !enabled.has(required));
        if (missing !== undefined) {
          throw new AppError(
            "VALIDATION_FAILED",
            `Module '${name}' requires module '${missing}', which is off. Turn 'modules.${missing}.enabled' on or turn '${name}' off`
          );
        }
      }
      const off = modules.filter((definition) => !enabled.has(definition.name));
      return Object.freeze({
        modules: Object.freeze(
          MODULE_NAMES.map((name) =>
            Object.freeze({ name, enabled: enabled.has(name), definition: byName.get(name) })
          )
        ),
        isEnabled: (name: ModuleName) => enabled.has(name),
        offModuleOf: (contribution: ModuleContribution, name: string) =>
          off.find((definition) => definition[contributionLists[contribution]]?.includes(name))
            ?.name
      });
    }
  });
}

function frozenList<T>(values: readonly T[] | undefined): readonly T[] {
  return Object.freeze([...(values ?? [])]);
}
