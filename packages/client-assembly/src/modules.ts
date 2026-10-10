import {
  createModuleRegistry,
  defineModule,
  type ModuleRegistry,
  type ModuleSnapshot
} from "@vivd-catalyst/core";
import { resolveModuleSwitches, type ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ClientInstanceCapability } from "./capabilities";

/** The Resources panel of a conversation and the list it reads. */
const resourcesModule = defineModule({
  name: "resources",
  operations: ["conversations.resources.list"],
  ui: ["conversation.resources"]
});

/** Changing agents and skills in the interface. Running an agent and a config push are core. */
const assetManagementModule = defineModule({
  name: "assetManagement",
  operations: [
    "assets.put",
    "assets.delete",
    "assets.revert",
    "assets.sync",
    "config_agents.set_default",
    "config_agents.set_availability"
  ],
  ui: ["settings.build"]
});

/** Inviting a user by an emailed link to set a password. */
const userInvitationsModule = defineModule({
  name: "userInvitations",
  operations: ["users.invitation.send"],
  ui: ["settings.users.invitation"]
});

/** The modules whose code ships with the platform. A capability declares its own. */
export const platformModules = [resourcesModule, assetManagementModule, userInvitationsModule];

export interface InstanceModules {
  /** The modules this build ships: the platform's and each capability's. */
  readonly registry: ModuleRegistry;
  readonly snapshot: ModuleSnapshot;
}

/**
 * Assembles the registry of this build and resolves the instance's switches against it. An
 * invalid combination stops the process here, before a store or a service is created. Every
 * reader takes the snapshot from here.
 */
export function resolveInstanceModules(
  config: ClientInstanceConfig,
  capabilities: readonly ClientInstanceCapability[] = []
): InstanceModules {
  const registry = createModuleRegistry([
    ...platformModules,
    ...capabilities.flatMap((capability) => capability.modules ?? [])
  ]);
  return { registry, snapshot: registry.snapshot(resolveModuleSwitches(config)) };
}
