import {
  AppError,
  createModuleRegistry,
  moduleConfigKey,
  type ModuleRegistry,
  type ModuleSnapshot
} from "@work-shape/catalyst-core";
import {
  resolveModuleSwitches,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import type { ClientInstanceCapability } from "./capabilities";
import { assembleDataStores, dataStoresModule } from "./data-stores";
import { assembleKnowledge, knowledgeModule } from "./knowledge";
import type {
  AssembledModules,
  ModuleAssembly,
  ModuleAssemblyParts,
  StartedModules
} from "./module-assembly";
import { appsModule } from "./platform-modules/apps";
import { assetManagementModule } from "./platform-modules/asset-management";
import { connectionsModule } from "./platform-modules/connections";
import { feedbackModule } from "./platform-modules/feedback";
import { personalApiKeysModule } from "./platform-modules/personal-api-keys";
import { resourcesModule } from "./platform-modules/resources";
import { userInvitationsModule } from "./platform-modules/user-invitations";
import { assembleWorkflows, workflowsModule } from "./workflows";

/**
 * The modules whose code ships with the platform, one file each. A capability declares its own.
 */
export const platformModules = [
  resourcesModule,
  assetManagementModule,
  userInvitationsModule,
  appsModule,
  connectionsModule,
  workflowsModule,
  dataStoresModule,
  knowledgeModule,
  personalApiKeysModule,
  feedbackModule
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
