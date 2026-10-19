import { resolveConfigLocale, resolveLocalizedString } from "@work-shape/catalyst-config-schema";
import { AppError, type Conversation, type ToolExecutionContext } from "@work-shape/catalyst-core";
import {
  PLATFORM_ASSET_LIST_MAX,
  type PlatformAssetFound,
  type PlatformContextRead
} from "@work-shape/catalyst-tool-execution";
import type { AssetCall } from "../assets/asset-access";
import { AssetWorkflow } from "../assets/asset-service";
import type { AssetWorkflowOptions } from "../types";
import { getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";
import { readPlatformContext } from "./platform-context";
import { workflowAuthoringContext } from "./workflow-authoring-context";

/** Orientation is about what this person can use in the conversation's workspace. */
export async function readAgentPlatformContext(
  options: AssetWorkflowOptions,
  call: AssetCall,
  context: ToolExecutionContext,
  conversation: Conversation | undefined,
  input?: { person?: string }
): Promise<PlatformContextRead> {
  const [read, adminName] = await Promise.all([
    readPlatformContext(options, call),
    options.stores.users.getInstanceAdminName({ clientInstanceId: options.clientInstanceId })
  ]);
  const workspace =
    conversation &&
    (await options.stores.workspaces.getWorkspace(
      options.clientInstanceId,
      conversation.collaborationWorkspaceId
    ));
  const locale = resolveConfigLocale(options.config.localization, {
    requestedLocale: context.locale
  });
  const available = workspace && (await getWorkspaceAssetSnapshot(options, workspace));
  const apps =
    workspace && options.modules.isEnabled("apps")
      ? await new AssetWorkflow(options).reads.list(
          call,
          { kind: "app", workspaceId: workspace.id, locale, forUse: true },
          { limit: PLATFORM_ASSET_LIST_MAX + 1 }
        )
      : [];

  const kinds = options.configAssets.kinds.kinds.filter(
    (kind) => options.modules.offModuleOf("kind", kind.kind) === undefined
  );
  const existing = new Set<string>(kinds.flatMap((kind) => Object.values(kind.actions)));
  const ofExisting = (actions: string[]) => actions.filter((action) => existing.has(action));
  return {
    ...(adminName ? { helpContact: { displayLabel: adminName } } : {}),
    ...(await workflowAuthoringContext(
      options,
      call,
      input,
      options.modules.isEnabled("workflows")
    )),
    availableHere: {
      agents: (available?.agents ?? []).map((agent) => ({
        name: agent.name,
        title: resolveLocalizedString(
          agent.displayName,
          locale,
          options.config.localization.defaultLocale
        )
      })),
      apps: apps
        .slice(0, PLATFORM_ASSET_LIST_MAX)
        .map((app) => ({ name: app.name, title: app.title })),
      appsTruncated: apps.length > PLATFORM_ASSET_LIST_MAX
    },
    instance: {
      name: read.instance.name,
      timeZone: options.config.clientInstance.timeZone ?? "UTC",
      timeZoneDefaulted: options.config.clientInstance.timeZone === undefined
    },
    modules: options.modules.modules.filter((module) => module.enabled).map(({ name }) => name),
    kinds: kinds.map((kind) => ({
      kind: kind.kind,
      plural: kind.plural,
      hasDraft: kind.lifecycle === "draft_published"
    })),
    actions: ofExisting(read.actions),
    assetActions: ofExisting(read.assetActions),
    workspaces: read.workspaces.flatMap((workspace) => {
      const actions = ofExisting(workspace.actions);
      return actions.length > 0 ? [{ ...workspace, actions }] : [];
    }),
    namespaces: read.namespaces.flatMap((namespace) => {
      const actions = ofExisting(namespace.actions);
      return actions.length > 0 ? [{ ...namespace, actions }] : [];
    })
  };
}

/** Discovery uses the same asset reader and localized titles as Studio. */
export async function listAgentVisibleAssets(
  options: AssetWorkflowOptions,
  call: AssetCall,
  context: ToolExecutionContext,
  conversation: Conversation | undefined,
  input: { kind?: string; text?: string }
): Promise<{ assets: PlatformAssetFound[]; truncated: boolean }> {
  const kinds = options.configAssets.kinds.kinds.filter(
    (kind) =>
      options.modules.offModuleOf("kind", kind.kind) === undefined &&
      (input.kind === undefined || kind.kind === input.kind)
  );
  if (kinds.length === 0)
    throw new AppError(
      "NOT_FOUND",
      `This platform has no kind '${input.kind}'. platform.context lists the kinds it has`,
      { reason: "unknown_kind" },
      { exposeMessage: true }
    );
  const workflow = new AssetWorkflow(options);
  const assets: PlatformAssetFound[] = [];
  for (const kind of kinds) {
    for (const workspaceId of [undefined, conversation?.collaborationWorkspaceId]) {
      const room = PLATFORM_ASSET_LIST_MAX - assets.length;
      const listed = await workflow.reads.list(
        call,
        {
          kind: kind.kind,
          locale: context.locale,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(workspaceId === undefined ? {} : { workspaceId })
        },
        { limit: room + 1 }
      );
      for (const asset of listed.slice(0, room))
        assets.push({
          kind: asset.kind,
          name: asset.name,
          title: asset.title,
          ...(asset.description === undefined ? {} : { description: asset.description })
        });
      if (listed.length > room) return { assets, truncated: true };
    }
  }
  return { assets, truncated: false };
}
