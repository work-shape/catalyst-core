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
  readonly modules: readonly { readonly name: ModuleName; readonly enabled: boolean }[];
  isEnabled(name: ModuleName): boolean;
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
      return Object.freeze({
        modules: Object.freeze(
          MODULE_NAMES.map((name) => Object.freeze({ name, enabled: enabled.has(name) }))
        ),
        isEnabled: (name: ModuleName) => enabled.has(name)
      });
    }
  });
}

function frozenList<T>(values: readonly T[] | undefined): readonly T[] {
  return Object.freeze([...(values ?? [])]);
}
