import { agentConfigSchema, resolveLocalizedString } from "@work-shape/catalyst-config-schema";
import { assertReferencesWithinOwners } from "./asset-owner-references";
import {
  AppError,
  type ConfigAssetMutation,
  type ConfigAssetRevisionOrigin,
  type FileSet,
  type AssetRepoWrite,
  type ConfigAssetStore,
  type JsonObject
} from "@work-shape/catalyst-core";
import { configValuesEqual, type WorkflowAssetKind } from "../asset-kinds/shared";
import { afterWrite, clearLiveOnceSwitches } from "./asset-after-write";
import { agentDraftAuthor } from "./agent-drafts";
import { writesSharedDraft } from "./shared-drafts";
import {
  findDefinition,
  validateAssetSet,
  withDefaultAgentName,
  withDefinition,
  type AssetSet
} from "./asset-set";
import {
  assertChangedAgentsAllowed,
  listsModelBindings,
  assertUpsertWithinLimits,
  assetKey,
  keptStored,
  loadStoredAssets,
  requireOwnerWorkspace,
  toJsonObject,
  requireInstanceFirstForDefault,
  setsInitialDefault,
  requireInstanceDefaultChange,
  type StoredAssets
} from "./asset-write-rules";
import { initialAgentPlacement, type AvailableIn } from "./asset-placement";
import { recordAssetEvent, recordCommitted, type AssetTarget } from "./asset-target";
import type { AssetCall } from "./asset-access";
import type { AssetWorkflowOptions } from "../types";

type Batch = Omit<
  Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0],
  "clientInstanceId" | "actor"
>;
interface UpsertHost {
  requireTellableChange(stored: StoredAssets, written: (set: AssetSet) => AssetSet): void;
  /** `write` is what the asset held and holds after, for the kind's part of the write. */
  apply(
    batch: Batch,
    write: { previous: unknown; config: JsonObject | undefined }
  ): ReturnType<ConfigAssetStore["applyConfigAssetMutations"]>;
}

export type AssetUpsert = {
  expectedRevision: number | null;
  operation?: "revert";
  expectedDraftRevision?: number | null;
  agentPublish?: number;
  /**
   * Tools given to the live agent (`agents.give_tools`): the write is a live revision, never a
   * draft, and a pending draft takes the tools along.
   */
  agentToolsGiven?: readonly string[];
  releaseDraft?: boolean;
  audit: "config_asset.updated" | "config_asset.reverted";
  /** The stored file set of the revision, with the id its asset has or gets. */
  fileSet?: { assetId: string; fileSetId: FileSet["id"] };
  /** The commit the revision names, for an asset whose files are a repository. */
  repository?: AssetRepoWrite;
  /** Where a new agent starts, as its caller asked. */
  availableIn?: AvailableIn;
  /** Where the revision came from, where it is not written as it stands. */
  origin?: ConfigAssetRevisionOrigin;
  /**
   * Asked under the lock of the write: whether the write makes the asset the asset of the
   * Page its origin names. It refuses the write by throwing.
   */
  pageLink?: () => Promise<boolean>;
  /** The files of the write as its event names them: path, hash and size, no content. */
  auditFiles?: readonly { path: string; sha256: string; bytes: number }[];
  /** Files of this folder write, used only for the kind's warnings. Never audited. */
  warningFiles?: readonly { path: string; bytes: Uint8Array }[];
};

/** Validate one config write, then save either an agent draft or an asset revision. */
export async function upsertAsset(
  options: AssetWorkflowOptions,
  call: AssetCall,
  target: AssetTarget,
  config: Record<string, unknown>,
  write: AssetUpsert,
  host: UpsertHost
) {
  const { kind, name } = target;
  const surface = write.operation === "revert" ? "revert" : "put";
  const kinds = options.configAssets.kinds.kinds;
  await requireOwnerWorkspace(options, target.address.workspaceId);
  const stored = await loadStoredAssets(options);
  const current = findDefinition(stored.set, kind.kind, name);
  kind.assertStoredWritable?.({ current });
  requireInstanceFirstForDefault(stored.set, kind, target.scope);
  const setsDefault = setsInitialDefault(stored.set, kind, target.scope);
  requireInstanceDefaultChange(call.access, kind, setsDefault);
  // A revert restores what was stored: only what the kind's server decides is kept as it is.
  const principalId = call.actor.id;
  const definition = keptStored(
    kind,
    current,
    write.releaseDraft
      ? config
      : write.operation === "revert"
        ? (kind.prepareRevert?.({ current, restored: config, principalId }) ?? config)
        : kind.prepareInteractiveUpsert({ current, next: config, principalId })
  );
  /** The set as the write would leave it. */
  const written = (set: AssetSet) => {
    const replaced = withDefinition(set, kind.kind, name, definition);
    return setsDefault ? withDefaultAgentName(replaced, name) : replaced;
  };
  host.requireTellableChange(stored, written);
  const validated = validateAssetSet(kinds, written(stored.set), stored.set);
  const next = findDefinition(validated, kind.kind, name);
  if (next === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Validated config ${kind.kind} '${name}' was not found`
    );
  }
  await assertReferencesWithinOwners(
    kinds,
    [
      {
        type: "upsert",
        kind: kind.kind,
        name,
        scope: target.scope,
        config: next
      }
    ],
    stored.assets,
    call.runtime?.locale ?? options.config.localization.defaultLocale,
    options
  );
  const { lists, warnings: toolWarnings } = await assertChangedAgentsAllowed(
    options,
    call.access,
    stored.set,
    validated,
    {
      names:
        kind.kind === "agent" && (!write.releaseDraft || !configValuesEqual(current, next))
          ? [name]
          : [],
      scope: target.scope.kind === "workspace" ? { workspaceId: target.scope.workspaceId } : {}
    }
  );
  if (!write.releaseDraft)
    assertUpsertWithinLimits(call.access, surface, kind, {
      name,
      current,
      next,
      modelBindingsListed: listsModelBindings(lists)
    });
  await kind.assertScopedWrite?.({
    clientInstanceId: options.clientInstanceId,
    scope: target.scope,
    name,
    definition: next,
    stores: options.stores,
    actor: call.actor
  });
  // An agent's write, and a team's or the instance's skill's, goes to its one shared draft
  // (AD-1, SKILL-DRAFT-1); its publish and a give of tools write the live revision.
  const toDraft =
    target.asset?.status === "active" &&
    write.agentPublish === undefined &&
    write.agentToolsGiven === undefined &&
    (await writesSharedDraft(options, kind.kind, target.scope));
  // A skill's config written alone keeps the folder of the draft it changes, not the live one's.
  const draftFolder =
    toDraft && kind.kind === "skill" && write.fileSet === undefined && target.asset
      ? await draftFolderOf(options, kind, target.asset.id, toJsonObject(next))
      : undefined;
  const mutations: ConfigAssetMutation[] = [
    {
      type: "upsert",
      kind: kind.kind,
      name,
      config: draftFolder?.config ?? toJsonObject(next),
      scope: target.scope,
      ...(write.operation ? { operation: write.operation } : {}),
      ...(toDraft
        ? {
            agentDraft: {
              expectedDraftRevision: write.expectedDraftRevision ?? null,
              author: agentDraftAuthor(call)
            }
          }
        : {}),
      ...(draftFolder?.fileSetId === undefined ? {} : { fileSetId: draftFolder.fileSetId }),
      ...(write.agentPublish === undefined ? {} : { agentPublish: write.agentPublish }),
      ...(write.agentToolsGiven === undefined
        ? {}
        : { agentToolsGiven: [...write.agentToolsGiven] }),
      // A kind with a published revision moves its draft with a write and nothing else.
      ...(kind.lifecycle === "draft_published" ? { draft: true as const } : {}),
      ...(write.fileSet ?? {}),
      ...(write.repository ? { repository: write.repository } : {})
    }
  ];
  if (setsDefault) {
    mutations.push({ type: "setDefaultAgent", agentName: name });
  }
  const { warnings, ...placement } = await initialAgentPlacement(options, call, kind, {
    name,
    creates: target.asset?.status !== "active",
    setsDefault,
    config: next,
    ...(write.availableIn === undefined ? {} : { availableIn: write.availableIn }),
    ...(target.address.workspaceId === undefined ? {} : { madeIn: target.address.workspaceId })
  });
  const savingAgent = agentConfigSchema.safeParse(
    call.agentName === undefined ? undefined : findDefinition(stored.set, "agent", call.agentName)
  );
  let pageLinked = false;
  const { pageLink } = write;
  const result = await host.apply(
    {
      ...(pageLink
        ? {
            underLock: async () => {
              pageLinked = await pageLink();
            }
          }
        : {}),
      baseRevisions: { [assetKey(kind.kind, name)]: write.expectedRevision },
      // The default is set for the first asset only, so the instance has none before.
      ...(setsDefault ? { baseDefaultAgentName: null } : {}),
      ...placement,
      ...revisionOrigin(
        call,
        write.origin,
        !savingAgent.success
          ? undefined
          : resolveLocalizedString(
              savingAgent.data.displayName,
              call.runtime?.locale ?? options.config.localization.defaultLocale,
              options.config.localization.defaultLocale
            )
      ),
      mutations
    },
    { previous: current, config: toJsonObject(next) }
  );
  // The revision this write was given. The asset is not read again: by now another write
  // may have given it a later one, which this caller did not make and must not be told as
  // the revision of its own content.
  const draftRevision = result.draftRevisions?.[assetKey(kind.kind, name)];
  if (draftRevision !== undefined)
    return {
      version: result.version,
      revision: draftRevision,
      draftRevision,
      publishedRevision: target.asset?.revision,
      warnings: [...toolWarnings, ...(kind.writeWarnings?.(next, write.warningFiles) ?? [])]
    };
  const revision = result.revisions[assetKey(kind.kind, name)];
  if (revision === undefined)
    throw new AppError("INTERNAL", "The asset writer allocated no revision");
  await recordCommitted(options, call, [
    () =>
      recordAssetEvent(call, write.audit, {
        kind: kind.kind,
        name,
        revision,
        version: result.version,
        // A revision that copies a Page names it: the trail says where the content came from.
        ...(write.origin?.kind === "page" ? { pageId: write.origin.pageId } : {}),
        ...(pageLinked ? { pageLinked: true } : {}),
        ...(write.auditFiles ? { files: write.auditFiles.map((file) => ({ ...file })) } : {}),
        // The names of the tools a give added, never what they do.
        ...(write.agentToolsGiven ? { givenTools: [...write.agentToolsGiven] } : {})
      })
  ]);
  await afterWrite(options, call, target, { previous: current, config: toJsonObject(next) });
  await clearLiveOnceSwitches(options, call, kind, name, target.asset?.id);
  return {
    version: result.version,
    revision,
    warnings: [
      ...warnings,
      ...toolWarnings,
      ...(kind.writeWarnings?.(next, write.warningFiles) ?? [])
    ]
  };
}

/**
 * Where the revision came from, with the agent named where an agent's call wrote it: a Page
 * it saved, or its own write. What an approval applied stays the approval's.
 */
function revisionOrigin(
  call: AssetCall,
  origin: ConfigAssetRevisionOrigin | undefined,
  agentDisplayName: string | undefined
): { origin?: ConfigAssetRevisionOrigin } {
  const conversationId = call.agentConversationId;
  if (conversationId === undefined) return origin ? { origin } : {};
  const agent = agentDisplayName ? { agentDisplayName } : {};
  if (origin === undefined) return { origin: { kind: "agent_run", conversationId, ...agent } };
  return { origin: origin.kind === "page" ? { ...origin, byAgent: true, ...agent } : origin };
}

/**
 * The config and file set of a skill's draft write that sends its config alone: the files the
 * config does not hold are those of the pending draft, where there is one, as a config write of
 * the live skill keeps the live one's (`withRevisionFiles`). None where no draft is pending:
 * the writer carries the live folder then.
 */
export async function draftFolderOf(
  options: AssetWorkflowOptions,
  kind: WorkflowAssetKind,
  assetId: string,
  config: JsonObject
): Promise<{ config: JsonObject; fileSetId?: FileSet["id"] } | undefined> {
  const hook = kind.revisionFiles;
  if (!hook) return undefined;
  const draft = await options.stores.agentProposals.get({
    clientInstanceId: options.clientInstanceId,
    agentId: assetId
  });
  if (!draft) return undefined;
  const carried = hook.carried(config, draft.config, draft.fileSetId !== undefined);
  return {
    config: carried,
    ...(draft.fileSetId !== undefined && "files" in carried ? { fileSetId: draft.fileSetId } : {})
  };
}
