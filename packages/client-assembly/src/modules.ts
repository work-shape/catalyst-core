import {
  AppError,
  createModuleRegistry,
  defineModule,
  moduleConfigKey,
  type ModuleRegistry,
  type ModuleSnapshot,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { resolveModuleSwitches, type ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ClientInstanceCapability } from "./capabilities";
import type { ClientInstanceEnv } from "./env";

/** The Resources panel of a conversation and the list it reads. */
const resourcesModule = defineModule({
  name: "resources",
  operations: ["conversations.resources.list"],
  ui: ["conversation.resources"]
});

/**
 * Changing agents and skills in the interface. Running an agent and a config push are core:
 * `assets.sync` carries a push too, so its workflow asks the switch and lets the release holder
 * pass where the module is off. For every other caller it is an operation of the module.
 */
const assetManagementModule = defineModule({
  name: "assetManagement",
  operations: [
    "assets.put",
    "assets.delete",
    "assets.revert",
    "assets.publish",
    "assets.discard_draft",
    "assets.set_default",
    "assets.set_availability"
  ],
  selfCheckedOperations: ["assets.sync"],
  ui: ["settings.build"]
});

/** Inviting a user by an emailed link to set a password. */
const userInvitationsModule = defineModule({
  name: "userInvitations",
  operations: ["users.invitation.send"],
  ui: ["settings.users.invitation"]
});

/**
 * Pages: the file sets a conversation keeps, their history, the route that serves them, the
 * tool that saves one and the job that builds it. The build runs in the sandbox, so the
 * workspace command worker serves it.
 */
const appsModule = defineModule({
  name: "apps",
  operations: [
    "pages.list",
    "pages.get",
    "pages.files.get",
    "pages.files.list",
    "pages.preview",
    "app_content.files.get",
    "app_kit.files.get",
    "apps.create_from_page",
    "apps.preview",
    "apps.sessions.context",
    "apps.sessions.call_action",
    "apps.sessions.call_connection"
  ],
  kinds: ["app"],
  tools: ["page.save"],
  jobKinds: ["page.bundle"],
  commandWorkerJobKinds: ["page.bundle"]
});

/**
 * Connections: the asset kind that holds the access to an outside system, and its list in
 * Build. Off, the kind does not exist on the instance: no call reads, lists or writes one and
 * no right on one is handed out, and no discovery runs. What the store holds stays and is
 * inactive.
 */
const connectionsModule = defineModule({
  name: "connections",
  operations: ["connections.get", "connections.test", "connections.list_tools"],
  kinds: ["connection"],
  jobKinds: ["connection.discover"],
  ui: ["build.connections"]
});

/** The modules whose code ships with the platform. A capability declares its own. */
export const platformModules = [
  resourcesModule,
  assetManagementModule,
  userInvitationsModule,
  appsModule,
  connectionsModule
];

export interface InstanceModules {
  /** The modules this build ships: the platform's and each capability's. */
  readonly registry: ModuleRegistry;
  readonly snapshot: ModuleSnapshot;
}

/**
 * Assembles the registry of this build and resolves the instance's switches against it. An
 * invalid combination stops the process here, before a store or a service is created. Every
 * reader takes the snapshot from here. `capabilities` has no default: a process that is
 * assembled without the capabilities of its build stops on the first module one of them owns.
 */
export function resolveInstanceModules(
  config: ClientInstanceConfig,
  capabilities: readonly ClientInstanceCapability[]
): InstanceModules {
  const registry = createModuleRegistry([
    ...platformModules,
    ...capabilities.flatMap((capability) => capability.modules ?? [])
  ]);
  return { registry, snapshot: registry.snapshot(resolveModuleSwitches(config)) };
}

/**
 * Ends a resolve-only run. The release gate starts every built process entry point of a
 * deployment with `CATALYST_RESOLVE_ONLY=1` once per release config. The process loads its
 * config and resolves its modules as it always does, then ends here with code 0, before it
 * opens a store or a provider. Each process of the instance calls this right after
 * `resolveInstanceModules`. Nothing but the gate sets the variable.
 */
export function endResolveOnlyRun(env: ClientInstanceEnv): void {
  if (env.CATALYST_RESOLVE_ONLY === "1") {
    process.exit(0);
  }
}

/**
 * Refuses a workspace command worker that does not serve a job kind that a module that is on
 * needs it to serve. `handlers` are the handlers of that worker. A save of a Page would
 * otherwise queue a build that no process ever takes.
 */
export function assertCommandWorkerServesModuleJobKinds(
  modules: ModuleSnapshot,
  handlers: readonly RegisteredJobHandler[]
): void {
  const served = new Set(
    handlers.filter((handler) => handler.slots > 0).map((handler) => handler.kind.kind)
  );
  for (const module of modules.modules) {
    if (!module.enabled) {
      continue;
    }
    const missing = module.definition?.commandWorkerJobKinds?.find((kind) => !served.has(kind));
    if (missing !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `'${moduleConfigKey(module.name)}' is true, but the workspace command worker of this assembly does not serve the job kind '${missing}'. The module needs that worker to serve it. Assemble the worker with 'createClientInstanceWorkspaceCommandWorker', or turn the module off`
      );
    }
  }
}
