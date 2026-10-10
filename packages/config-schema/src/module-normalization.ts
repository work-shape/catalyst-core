import { AppError, type ModuleName, type ModuleSwitches } from "@vivd-catalyst/core";
import { isPasswordMailEnabled } from "./branding";
import type { ClientInstanceConfig } from "./schemas";

/**
 * The switch a module had before `modules.<name>.enabled` existed. `explicit` is what the
 * config says under the legacy key and `fallback` is what the instance got without one.
 */
interface LegacyModuleSwitch {
  name: ModuleName;
  key?: string;
  explicit?: boolean;
  fallback: boolean;
}

/**
 * The switches of every module as the instance runs them. Four modules had their own switch
 * before the `modules` section. For one transition release a config that still uses a legacy
 * key, or no key at all, keeps the state it has today: the new key wins when it is the only one
 * set, the legacy key or its former default applies otherwise, and a config that sets both to
 * different values is refused, because no order of precedence would be right for every
 * instance.
 *
 * In the release after the transition release the legacy keys leave the schemas, this file is
 * deleted and every module without an entry is off.
 */
export function resolveModuleSwitches(config: ClientInstanceConfig): ModuleSwitches {
  const switches: Record<string, { enabled: boolean }> = { ...config.modules };
  for (const legacy of legacyModuleSwitches(config)) {
    const explicit = config.modules[legacy.name]?.enabled;
    if (
      explicit !== undefined &&
      legacy.explicit !== undefined &&
      legacy.key !== undefined &&
      explicit !== legacy.explicit
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        `'modules.${legacy.name}.enabled' is ${String(explicit)} but the legacy key '${legacy.key}' is ${String(legacy.explicit)}. Remove '${legacy.key}' from the config`
      );
    }
    switches[legacy.name] = { enabled: explicit ?? legacy.explicit ?? legacy.fallback };
  }
  return switches;
}

function legacyModuleSwitches(config: ClientInstanceConfig): LegacyModuleSwitch[] {
  return [
    {
      name: "documents",
      key: "capabilities.documentProcessing.enabled",
      explicit: enabledFlag(config.capabilities.documentProcessing),
      fallback: false
    },
    {
      name: "resources",
      key: "ui.resources.enabled",
      explicit: config.ui.resources.enabled,
      fallback: true
    },
    {
      name: "assetManagement",
      key: "administration.agentConfiguration.enabled",
      explicit: config.administration.agentConfiguration.enabled,
      fallback: false
    },
    // Invitations had no key: they were on wherever their mail could be sent.
    { name: "userInvitations", fallback: isPasswordMailEnabled(config) }
  ];
}

/** The `enabled` flag of a capability's config, which this package does not parse. */
function enabledFlag(capabilityConfig: unknown): boolean | undefined {
  if (typeof capabilityConfig !== "object" || capabilityConfig === null) {
    return undefined;
  }
  const enabled: unknown = Reflect.get(capabilityConfig, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
}
