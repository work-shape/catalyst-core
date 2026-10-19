import { asCollaborationWorkspaceId, type AgentAvailability } from "@work-shape/catalyst-core";
import { readDefinitionName } from "../asset-kinds/shared";
import type { AssetWorkflowOptions } from "../types";
import type { AssetCall } from "./asset-access";
import { agentDependencyAvailability } from "./agent-dependency-availability";
import { resolveAssetTarget } from "./asset-target";
import { assertReferencesWithinOwners } from "./asset-owner-references";
import { findAssetSetIssues, findDefinition, withDefinition, type AssetSet } from "./asset-set";
import {
  requireAssetKindModuleOn,
  assetKey,
  findIssuesOfChange,
  loadReferableAssets,
  loadStoredAssets,
  storedWritableIssues,
  setsInitialDefault,
  writeIssuesOf
} from "./asset-write-rules";

/** The content and dependency preview of assets.validate; it writes no asset or availability. */
export async function validateAssetDefinition(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: {
    kind: string;
    config: Record<string, unknown>;
    workspaceId?: string;
    availability?: Omit<AgentAvailability, "collaborationWorkspaceIds"> & {
      collaborationWorkspaceIds: string[];
    };
  }
) {
  const name = readDefinitionName(input.config);
  requireAssetKindModuleOn(options.modules, input.kind);
  const target = await resolveAssetTarget(options, options.configAssets.kinds.require(input.kind), {
    ...input,
    name: name ?? ""
  });
  const { kind } = target;
  call.access.require(kind.actions.read, target.resource);
  const kinds = options.configAssets.kinds.kinds;
  const stored = await loadStoredAssets(options);
  const view = loadReferableAssets(options, call.access, stored);
  const current = name === undefined ? undefined : findDefinition(view.set, kind.kind, name);
  const prepared = kind.prepareInteractiveUpsert({
    current,
    next: input.config,
    principalId: call.actor.id
  });
  const drafted = (set: AssetSet) => withDefinition(set, kind.kind, name ?? "", prepared);
  const found = findAssetSetIssues(kinds, drafted(view.set), view.set);
  const ofDefinition = view.complete
    ? found.issues
    : findIssuesOfChange(
        kinds,
        stored.set,
        view,
        drafted,
        new Set([assetKey(kind.kind, name ?? "")]),
        call.runtime?.locale ?? options.config.localization.defaultLocale
      );
  // What is stored and read-only is refused before the definition is read, as a put is.
  const readOnly = storedWritableIssues(kind, current);
  const checked =
    readOnly || ofDefinition.length > 0
      ? { issues: readOnly ?? ofDefinition, warnings: [] }
      : await writeIssuesOf(
          options,
          call.access,
          view.set,
          found,
          async () => {
            const { scope } = target;
            const write = { type: "upsert", kind: kind.kind, name: name ?? "", scope } as const;
            await assertReferencesWithinOwners(
              kinds,
              [{ ...write, config: prepared }],
              stored.assets,
              call.runtime?.locale ?? options.config.localization.defaultLocale,
              options
            );
          },
          {
            names: kind.kind === "agent" && name !== undefined ? [name] : [],
            scope:
              target.scope.kind === "workspace" ? { workspaceId: target.scope.workspaceId } : {}
          },
          // A put asks this of the validated definition before it stores it; so does a check.
          () =>
            kind.assertScopedWrite?.({
              clientInstanceId: options.clientInstanceId,
              scope: target.scope,
              name: name ?? "",
              definition: findDefinition(found.accepted, kind.kind, name ?? "") ?? prepared,
              stores: options.stores,
              actor: call.actor
            }) ?? Promise.resolve()
        );
  const dependencyAvailability =
    checked.issues.length === 0 &&
    kind.kind === "agent" &&
    input.availability !== undefined &&
    call.access.authorize(kind.actions.write, target.resource).allowed
      ? await agentDependencyAvailability(
          options,
          call,
          prepared,
          setsInitialDefault(stored.set, kind, target.scope)
            ? { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
            : {
                ...input.availability,
                collaborationWorkspaceIds: input.availability.collaborationWorkspaceIds.map(
                  asCollaborationWorkspaceId
                )
              }
        )
      : undefined;
  const warnings = [
    ...checked.warnings,
    // A definition that holds is asked what its kind warns of; one with issues is not.
    ...(checked.issues.length > 0
      ? []
      : ((await kind.validationWarnings?.({
          clientInstanceId: options.clientInstanceId,
          definition: prepared,
          stores: options.stores
        })) ?? []))
  ];
  return {
    ...(dependencyAvailability ? { dependencyAvailability } : {}),
    valid: checked.issues.length === 0,
    ...(warnings.length ? { warnings } : {}),
    issues: checked.issues.map(({ message, path, code }) => ({
      message,
      ...(path === undefined || path.length === 0 ? {} : { path: path.map(String) }),
      ...(code === undefined ? {} : { code })
    }))
  };
}
