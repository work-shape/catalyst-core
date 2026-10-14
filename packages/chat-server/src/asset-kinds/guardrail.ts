import { guardrailConfigSchema } from "@vivd-catalyst/config-schema";
import {
  AppError,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  GUARDRAIL_ACTIONS,
  GUARDRAIL_ASSET_KIND,
  GUARDRAIL_NAME_MAX_LENGTH,
  GUARDRAIL_NAME_PATTERN,
  GUARDRAIL_NAME_RULE,
  GUARDRAIL_READ_ONLY_REASON,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_OPERATION_PREFIX,
  WORKFLOW_ASSET_KIND,
  WORKFLOW_OPERATION_PREFIX,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  defineAssetKind,
  isAgentAvailableInWorkspace,
  type AssetScope,
  type ClientInstanceId,
  type GuardrailConfig,
  type GuardrailFilter,
  type PlatformStores
} from "@vivd-catalyst/core";
import { readDefinitionField, type WorkflowAssetKind } from "./shared";

const AGENT_ASSET_KIND = "agent";

/** The reason of the refusal of a workspace guardrail whose filter reaches outside its workspace. */
export const GUARDRAIL_OUTSIDE_SCOPE_REASON = "guardrail_filter_outside_scope";

/**
 * The refusal of every change of a Guardrail of release config through the asset operations.
 * Release config defines them and the release seed alone writes them, to the store and
 * through no operation.
 */
function readOnly(): AppError {
  return new AppError(
    "FORBIDDEN",
    `${GUARDRAIL_READ_ONLY_REASON}: a Guardrail of release config is read-only here. Change it in release config`,
    { reason: GUARDRAIL_READ_ONLY_REASON }
  );
}

/** The kind of asset each operation prefix names one of, by its name after the prefix. */
const OPERATION_ASSET_KINDS: readonly (readonly [prefix: string, kind: string])[] = [
  [DATA_STORE_OPERATION_PREFIX, DATA_STORE_ASSET_KIND],
  [WORKFLOW_OPERATION_PREFIX, WORKFLOW_ASSET_KIND],
  [KNOWLEDGE_OPERATION_PREFIX, KNOWLEDGE_BASE_ASSET_KIND]
];

/**
 * The asset an operation filter names, as `data_store.kunden.insert` names the Data Store
 * `kunden`: nothing for a prefix of every asset of a kind, `data_store.*`, which a workspace
 * guardrail narrows to its workspace by its reach.
 */
function assetOfOperation(operation: string): { kind: string; name: string } | undefined {
  for (const [prefix, kind] of OPERATION_ASSET_KINDS) {
    if (!operation.startsWith(prefix)) continue;
    const name = operation.slice(prefix.length).split(".")[0];
    return name === undefined || name === "" || name === "*" ? undefined : { kind, name };
  }
  return undefined;
}

/**
 * What a workspace guardrail's filter names outside its workspace: another workspace, an
 * agent not offered there, or an asset another workspace owns. A workspace guardrail applies
 * to its workspace's events only, so its filter may narrow them and never reach further; an
 * instance guardrail's filter may name anything. Spec: events-workflows-and-guardrails.md,
 * Scope and publishing.
 */
export async function guardrailReachIssues(input: {
  clientInstanceId: ClientInstanceId;
  scope: AssetScope;
  filter: GuardrailFilter | undefined;
  stores: Pick<PlatformStores, "configAssets" | "workspaces">;
}): Promise<string[]> {
  const { scope, filter, stores, clientInstanceId } = input;
  if (scope.kind !== "workspace" || !filter) return [];
  const issues: string[] = [];
  if (filter.workspace !== undefined && filter.workspace !== scope.workspaceId) {
    issues.push(`its filter names the workspace '${filter.workspace}', which is not its own`);
  }
  if (filter.agent !== undefined) {
    const agent = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: AGENT_ASSET_KIND,
      name: filter.agent
    });
    const available =
      agent?.status === "active" &&
      (agent.scope.kind === "workspace"
        ? assetScopesEqual(agent.scope, scope)
        : await offeredIn(input, filter.agent, scope.workspaceId));
    if (!available) {
      issues.push(`its filter names the agent '${filter.agent}', which this workspace does not offer`);
    }
  }
  const named = filter.operation === undefined ? undefined : assetOfOperation(filter.operation);
  if (named) {
    const asset = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: named.kind,
      name: named.name
    });
    if (asset?.status === "active" && asset.scope.kind === "workspace" && !assetScopesEqual(asset.scope, scope)) {
      issues.push(`its filter names the operation '${filter.operation}' of another workspace`);
    }
  }
  return issues;
}

async function offeredIn(
  input: Parameters<typeof guardrailReachIssues>[0],
  agentName: string,
  workspaceId: string
): Promise<boolean> {
  const { stores, clientInstanceId } = input;
  const [availability, workspace] = await Promise.all([
    stores.configAssets.listAgentAvailability({ clientInstanceId, agentName }),
    stores.workspaces.getWorkspace(clientInstanceId, asCollaborationWorkspaceId(workspaceId))
  ]);
  return (
    workspace !== undefined &&
    isAgentAvailableInWorkspace(availability.get(agentName), {
      kind: workspace.kind,
      id: workspace.id
    })
  );
}

/** Refuses a workspace guardrail whose filter reaches outside its workspace. */
export async function assertGuardrailReach(
  input: Parameters<typeof guardrailReachIssues>[0] & { name: string }
): Promise<void> {
  const issues = await guardrailReachIssues(input);
  if (issues.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Guardrail '${input.name}' applies in its workspace only, and ${issues.join("; ")}`,
      {
        reason: GUARDRAIL_OUTSIDE_SCOPE_REASON,
        issues: issues.map((message) => ({ message, path: ["filter"] }))
      }
    );
  }
}

/**
 * The Guardrail kind: a check bound to a before-event, with the outcome of a hit. A
 * guardrail of release config is published by the release seed and read-only; one written as
 * an asset is a draft until a holder of `guardrail.publish` at its scope, the instance or one
 * workspace, publishes it. It is no part of the release bundle and offered in no workspace
 * list.
 */
export function createGuardrailAssetKind(): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: GUARDRAIL_ASSET_KIND,
      plural: "guardrails",
      schema: guardrailConfigSchema,
      nameRule: {
        pattern: GUARDRAIL_NAME_PATTERN,
        maxLength: GUARDRAIL_NAME_MAX_LENGTH,
        description: GUARDRAIL_NAME_RULE
      },
      actions: { ...GUARDRAIL_ACTIONS },
      lifecycle: "draft_published",
      owners: ["instance", "workspace"],
      // A Guardrail refers to no other asset: its model binding is release config's own.
      validate: () => [],
      validateWrite(context, guardrails) {
        // Only the release seed writes the floor, and it writes through no operation.
        if (
          guardrails.some(
            (guardrail) =>
              guardrail.origin === "release" &&
              context.changes(GUARDRAIL_ASSET_KIND, guardrail.name)
          )
        ) {
          throw readOnly();
        }
        return [];
      },
      summarize: (guardrail: GuardrailConfig) => ({
        name: guardrail.name,
        title: guardrail.displayName,
        ...(guardrail.description === undefined ? {} : { description: guardrail.description }),
        attributes: {
          event: guardrail.on,
          checkKind: guardrail.check.kind,
          outcome: guardrail.outcome,
          origin: guardrail.origin,
          ...(guardrail.filter?.kind === undefined ? {} : { appliesTo: guardrail.filter.kind }),
          ...(guardrail.filter?.operation === undefined
            ? {}
            : { operation: guardrail.filter.operation }),
          ...(guardrail.filter?.origin === undefined
            ? {}
            : { callOrigin: guardrail.filter.origin }),
          ...(guardrail.filter?.agent === undefined ? {} : { agent: guardrail.filter.agent }),
          ...(guardrail.filter?.workspace === undefined
            ? {}
            : { workspace: guardrail.filter.workspace })
        }
      })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    // Asked before anything else of a write, a delete and a sync included.
    assertStoredWritable({ current }) {
      if (readDefinitionField(current, "origin") === "release") {
        throw readOnly();
      }
    },
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    // The floor is published by the release seed alone, an earlier revision of it included.
    authorizeLive({ config }) {
      if (readDefinitionField(config, "origin") === "release") {
        throw readOnly();
      }
    },
    assertScopedWrite: ({ clientInstanceId, scope, name, definition, stores }) =>
      assertGuardrailReach({
        clientInstanceId,
        scope,
        name,
        filter: filterOf(definition),
        stores
      }),
    // The world may have moved since the draft was saved: an agent offered elsewhere now.
    onPublish: ({ clientInstanceId, scope, config, stores }) =>
      assertGuardrailReach({
        clientInstanceId,
        scope,
        name: String(config.name),
        filter: filterOf(config),
        stores
      })
  };
}

function filterOf(definition: unknown): GuardrailFilter | undefined {
  const parsed = guardrailConfigSchema.safeParse(definition);
  return parsed.success ? parsed.data.filter : undefined;
}
