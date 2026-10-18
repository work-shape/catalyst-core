import {
  AppError,
  createModuleRegistry,
  defineModule,
  moduleConfigKey,
  type ModuleRegistry,
  type ModuleSnapshot
} from "@work-shape/catalyst-core";
import {
  resolveModuleSwitches,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  CONNECTION_DRAFT_TOOL_NAME,
  APP_PUBLISH_TOOL_NAME,
  PLATFORM_ASSET_TOOLS
} from "@work-shape/catalyst-tool-execution";
import type { ClientInstanceCapability } from "./capabilities";
import { assembleDataStores, dataStoresModule } from "./data-stores";
import { assembleKnowledge, knowledgeModule } from "./knowledge";
import type {
  AssembledModules,
  ModuleAssembly,
  ModuleAssemblyParts,
  StartedModules
} from "./module-assembly";
import { assembleWorkflows, workflowsModule } from "./workflows";

/** The Resources panel of a conversation and the list it reads. */
const resourcesModule = defineModule({
  name: "resources",
  operations: ["conversations.resources.list"],
  ui: ["conversation.resources"]
});

/**
 * Changing agents and skills in the interface. Running an agent and a config push are core:
 * `assets.sync` carries a push too, so its workflow asks the switch and lets the release holder
 * pass where the module is off. A person may also publish a release-written agent draft
 * there; assets.publish checks that provenance itself. Other interactive writes stay bound.
 */
const assetManagementModule = defineModule({
  name: "assetManagement",
  operations: [
    "assets.put",
    "assets.delete",
    "assets.revert",
    "assets.discard_draft",
    "assets.run_live_once",
    "assets.set_default",
    "assets.set_availability",
    "agents.draft.discard",
    "agents.try.open",
    "guardrails.unpublish"
  ],
  selfCheckedOperations: ["assets.sync", "assets.publish"],
  // The agent's save of a draft is a change of an asset like `assets.put`, which it projects.
  tools: [PLATFORM_ASSET_TOOLS.put.name],
  ui: ["settings.build"]
});

/** Inviting a user by an emailed link to set a password. */
const userInvitationsModule = defineModule({
  name: "userInvitations",
  operations: ["users.invitation.send"],
  ui: ["settings.users.invitation"]
});

/**
 * Apps and their previews: the file sets a conversation keeps, their history, the route that
 * serves them, the tools that open a folder and save it as an App, and the job that builds it. The build runs in the sandbox, so the
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
    "apps.actions.list",
    "apps.update_from_page",
    "apps.get_from_page",
    "apps.preview",
    "apps.sessions.context",
    "apps.sessions.call_action",
    "apps.sessions.get_workflow_run"
  ],
  kinds: ["app"],
  tools: ["workspace.open", "app.save", APP_PUBLISH_TOOL_NAME],
  jobKinds: ["page.bundle", "asset_repo.commit", "asset_repo.sweep"],
  commandWorkerJobKinds: ["page.bundle", "asset_repo.commit", "asset_repo.sweep"]
});

/**
 * Connections: the asset kind that holds the access to an outside system, and its list in
 * Build. Off, the kind does not exist on the instance: no call reads, lists or writes one and
 * no right on one is handed out, and no discovery runs. What the store holds stays and is
 * inactive.
 */
const connectionsModule = defineModule({
  name: "connections",
  operations: [
    "connections.get",
    "connections.test",
    "connections.set_secret",
    "connections.discover",
    "connections.oauth_start",
    "connections.oauth_complete",
    "connections.disconnect",
    "connections.person_context",
    "connections.set_person_context",
    "connections.list_tools"
  ],
  kinds: ["connection"],
  // The agent's draft of a REST API's tools checks them against the instance's Connector types.
  tools: [CONNECTION_DRAFT_TOOL_NAME],
  jobKinds: [
    "connection.discover",
    "connection_setup_sessions.sweep",
    "connection_bindings.keep_alive"
  ],
  ui: ["build.connections"]
});

/**
 * Personal API keys: a person issues keys that act as themself, narrowed to their scopes, in
 * Settings or by confirming the CLI's connect code; whoever holds `api_access.manage` sees and
 * revokes every person's keys. Off, no personal key authenticates (`createClientInstanceAuth`)
 * and the keys stay stored, revocable when the module is on again.
 */
const personalApiKeysModule = defineModule({
  name: "personalApiKeys",
  operations: [
    "me.api_keys.list",
    "me.api_keys.create",
    "me.api_keys.revoke",
    "me.connect_codes.get",
    "me.connect_codes.confirm",
    "connect_codes.start",
    "connect_codes.redeem",
    "personal_api_keys.list",
    "personal_api_keys.revoke"
  ],
  ui: ["settings.you.api-keys", "settings.you.connect", "settings.api-access.personal-keys"]
});

/** The modules whose code ships with the platform. A capability declares its own. */
export const platformModules = [
  resourcesModule,
  assetManagementModule,
  userInvitationsModule,
  appsModule,
  connectionsModule,
  workflowsModule,
  dataStoresModule,
  knowledgeModule,
  personalApiKeysModule
];

/**
 * The seams of the modules that are assembled through one. A new one is one more entry. A seam
 * comes after the seams whose offers it takes: Knowledge Bases after Data Stores.
 */
const moduleSeams = [assembleWorkflows, assembleDataStores, assembleKnowledge];

/**
 * Builds what the modules with a seam add to this process, each list in the order of the
 * seams. A module that is off adds nothing.
 */
export async function assembleModules(parts: ModuleAssemblyParts): Promise<AssembledModules> {
  const assemblies: ModuleAssembly[] = [];
  for (const seam of moduleSeams) {
    assemblies.push((await seam(parts, [...assemblies])) ?? {});
  }
  return {
    approvalRequestHandlers: assemblies.flatMap(
      (assembly) => assembly.approvalRequestHandlers ?? []
    ),
    assetKinds: assemblies.flatMap((assembly) => assembly.assetKinds ?? []),
    tools: assemblies.flatMap((assembly) => assembly.tools ?? []),
    ...firstPublishNarrativeData(assemblies),
    async start(runtime): Promise<StartedModules> {
      for (const assembly of assemblies) {
        for (const source of assembly.operationSources?.(runtime) ?? []) {
          runtime.operationCalls.registry.addSource(source);
        }
      }
      const started: Awaited<ReturnType<NonNullable<ModuleAssembly["start"]>>>[] = [];
      for (const assembly of assemblies) {
        started.push((await assembly.start?.(runtime)) ?? {});
      }
      return {
        jobHandlers: started.flatMap((module) => module.jobHandlers ?? []),
        schedules: started.flatMap((module) => module.schedules ?? []),
        jobRetries: started.flatMap((module) => module.jobRetries ?? []),
        routes: started.flatMap((module) => module.routes ?? []),
        dataToolSources: started.flatMap((module) => module.dataToolSources ?? []),
        async close() {
          for (const module of [...started].reverse()) {
            await module.close?.();
          }
        }
      };
    }
  };
}

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

/** What a resolve-only run prints before it ends. The release gate looks for this line. */
const RESOLVE_ONLY_MARKER = "resolve-only: this process starts with this config";

/** Whether the release gate started this process with `--resolve-only`. */
export function isResolveOnlyRun(): boolean {
  return process.argv.includes("--resolve-only");
}

/**
 * Ends a resolve-only run. The release gate starts every built process entry point of a
 * deployment with the argument `--resolve-only`, once per release config. The process loads
 * its config, resolves its modules and makes every check that needs nothing but the config
 * and the build, as it always does. Then it prints the marker and ends here with code 0,
 * before it opens a store or a provider. Each process of the instance calls this once, below
 * the last of those checks.
 */
export function endResolveOnlyRun(): void {
  if (isResolveOnlyRun()) {
    process.stdout.write(`${RESOLVE_ONLY_MARKER}\n`);
    process.exit(0);
  }
}

/**
 * Refuses a workspace command worker that does not serve a job kind that a module that is on
 * needs it to serve. `served` are the job kinds that worker has a handler for. A save of a
 * Page would otherwise queue a build that no process ever takes.
 */
export function assertCommandWorkerServesModuleJobKinds(
  modules: ModuleSnapshot,
  served: readonly string[]
): void {
  for (const module of modules.modules) {
    if (!module.enabled) {
      continue;
    }
    const missing = module.definition?.commandWorkerJobKinds?.find(
      (kind) => !served.includes(kind)
    );
    if (missing !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `'${moduleConfigKey(module.name)}' is true, but the workspace command worker of this assembly does not serve the job kind '${missing}'. The module needs that worker to serve it. Assemble the worker with 'createClientInstanceWorkspaceCommandWorker', or turn the module off`
      );
    }
  }
}

/** The stored-data answer of the publish question: the first module that offers one. */
function firstPublishNarrativeData(
  assemblies: readonly ModuleAssembly[]
): Pick<AssembledModules, "publishNarrativeData"> {
  const found = assemblies.find((assembly) => assembly.publishNarrativeData)?.publishNarrativeData;
  return found ? { publishNarrativeData: found } : {};
}
