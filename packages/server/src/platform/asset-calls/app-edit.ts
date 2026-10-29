import {
  AppError,
  asUserId,
  createPlatformId,
  fileSetContentType,
  getRuntimeSubjectUserId,
  type ActorAccess,
  type Conversation,
  type ObjectStorage,
  type RuntimeCallContext,
  type UpsertWorkspaceFileInput
} from "@work-shape/catalyst-core";
import {
  DEFAULT_LIMITS,
  normalizeWorkspaceFilePath,
  putWorkspaceFile,
  type AppEdited,
  type PlatformAssetCalls
} from "@work-shape/catalyst-tool-execution";
import { assetTitle } from "../../assets/asset-reference-labels";
import {
  requireOwnTranscript,
  subjectUnavailable
} from "../../conversations/platform-asset-subject";
import { readFileSetFile, storePageFileSet } from "../../pages/page-file-sets";
import type { AssetWorkflowOptions } from "../../types";
import type { AssetCallScope } from "./scope";

/** The agent's `app.edit`: the checkout below, in the conversation the call came from. */
export function appEditCalls(
  scope: AssetCallScope,
  workspaceObjects?: ObjectStorage
): Pick<PlatformAssetCalls, "editApp"> {
  const { options, conversationOf, callOf } = scope;
  return {
    async editApp(context, input) {
      const conversation = await conversationOf(context);
      const call = await callOf(context);
      return checkoutApp(options, workspaceObjects, {
        conversation,
        access: call.access,
        context,
        name: input.name
      });
    }
  };
}

/**
 * The App a person may change, in the workspace of `workspaceId`: its active row, where the
 * module is on and `access` holds `app.write` on it. Refuses before any file or author is read,
 * and an App that is not there or not in that workspace alike.
 */
export async function requireAppToCheckOut(
  options: AssetWorkflowOptions,
  access: Pick<ActorAccess, "require">,
  input: { name: string; workspaceId: string }
) {
  const row = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: "app",
    name: input.name
  });
  if (
    row?.status !== "active" ||
    row.scope.kind !== "workspace" ||
    row.scope.workspaceId !== input.workspaceId ||
    options.modules.offModuleOf("kind", "app") !== undefined
  )
    throw subjectUnavailable();
  access.require("app.write", {
    kind: "app",
    name: row.name,
    assetId: row.id,
    workspaceId: row.scope.workspaceId
  });
  return { ...row, workspaceId: row.scope.workspaceId };
}

/**
 * Loads an App's current draft with all its files into `apps/<name>` of a conversation of the
 * person's own, binds that folder in `asset_checkouts` and makes the App the conversation's
 * subject: the agent's `app.edit`, and "Edit in chat" on the App's page.
 * Working files inherit conversation retention; immutable App files keep the App's lifetime.
 * App write is checked before any file or author is read. No new right, region or payload audit.
 */
export async function checkoutApp(
  options: AssetWorkflowOptions,
  workspaceObjects: ObjectStorage | undefined,
  input: {
    conversation: Conversation;
    access: Pick<ActorAccess, "require">;
    context: RuntimeCallContext;
    name: string;
  }
): Promise<AppEdited> {
  const { conversation, context } = input;
  await requireOwnTranscript(options, conversation);
  const row = await requireAppToCheckOut(options, input.access, {
    name: input.name,
    workspaceId: conversation.collaborationWorkspaceId
  });
  if (!workspaceObjects || !options.pages)
    throw new AppError("CONFLICT", "App editing needs storage for workspace files", {
      reason: "files_unavailable"
    });
  if (!row.fileSetId || !row.commit)
    throw new AppError("CONFLICT", "This App has no draft repository to check out", {
      reason: "repository_unavailable"
    });
  const source = await options.stores.pages.getAssetFileSet({
    clientInstanceId: options.clientInstanceId,
    assetId: row.id,
    fileSetId: row.fileSetId
  });
  if (!source) throw subjectUnavailable();
  const baseCommit = row.commit;
  const path = `apps/${row.name}`;
  const workspace = await options.stores.executionWorkspaces.ensureExecutionWorkspace({
    clientInstanceId: options.clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: getRuntimeSubjectUserId(context),
    now: new Date().toISOString()
  });
  const existing = await options.stores.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: options.clientInstanceId,
    workspaceId: workspace.id
  });
  const limits = {
    ...DEFAULT_LIMITS,
    maxWorkspaceBytes: options.config.executionWorkspaces.command.maxWorkspaceBytes
  };
  const remaining = existing.filter((file) => !file.path.startsWith(`${path}/`));
  const total =
    remaining.reduce((sum, file) => sum + file.byteSize, 0) +
    source.sourceFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (total > limits.maxWorkspaceBytes)
    throw new AppError(
      "VALIDATION_FAILED",
      "The App's files do not fit in this conversation's workspace. Remove unused workspace files and call app.edit again."
    );
  for (const file of source.sourceFiles) {
    const normalized = normalizeWorkspaceFilePath(`${path}/${file.path}`, limits);
    if (normalized.status === "failed") throw new AppError("VALIDATION_FAILED", normalized.message);
    if (
      remaining.some(
        (other) =>
          normalized.value.startsWith(`${other.path}/`) ||
          other.path.startsWith(`${normalized.value}/`)
      )
    ) {
      throw new AppError(
        "CONFLICT",
        "A workspace file occupies the App's folder. Move it with workspace.exec and call app.edit again."
      );
    }
  }
  const sourceFiles = [];
  const writes: UpsertWorkspaceFileInput[] = [];
  const commandId = createPlatformId<"WorkspaceCommandId">("wcmd_edit");
  for (const file of source.sourceFiles) {
    context.signal?.throwIfAborted();
    const bytes = await readFileSetFile(options, source, "src", file);
    sourceFiles.push({ path: file.path, bytes });
    const stored = await putWorkspaceFile(workspaceObjects, {
      clientInstanceId: options.clientInstanceId,
      conversationId: conversation.id,
      workspaceId: workspace.id,
      commandId,
      path: `${path}/${file.path}`,
      bytes,
      checksum: file.sha256,
      mimeType: fileSetContentType(file.path)
    });
    writes.push({
      clientInstanceId: options.clientInstanceId,
      workspaceId: workspace.id,
      path: `${path}/${file.path}`,
      objectKey: stored.objectKey,
      byteSize: bytes.byteLength,
      checksum: file.sha256,
      mimeType: fileSetContentType(file.path),
      metadata: { source: "app.edit" }
    });
  }
  const builtFiles = [];
  for (const file of source.builtFiles)
    builtFiles.push({
      path: file.path,
      bytes: await readFileSetFile(options, source, "dist", file)
    });
  const { page, fileSet } = await storePageFileSet(
    options,
    {
      conversationId: conversation.id,
      pageName: path,
      kitVersion: source.kitVersion,
      manifest: source.manifest,
      sourceFiles,
      builtFiles,
      createdByUserId: asUserId(getRuntimeSubjectUserId(context)),
      ...(context.signal ? { signal: context.signal } : {})
    },
    (create) =>
      options.stores.transaction(async (stores) => {
        const copied = await create(stores);
        for (const file of existing.filter((file) => file.path.startsWith(`${path}/`))) {
          await stores.executionWorkspaces.deleteWorkspaceFile({
            clientInstanceId: options.clientInstanceId,
            workspaceId: workspace.id,
            path: file.path
          });
        }
        for (const write of writes) await stores.executionWorkspaces.upsertWorkspaceFile(write);
        await stores.configAssets.setAssetCheckout({
          clientInstanceId: options.clientInstanceId,
          conversationId: conversation.id,
          folder: path,
          assetId: row.id,
          baseCommit,
          baseRevision: row.revision
        });
        await stores.conversations.setConversationSubject({
          clientInstanceId: options.clientInstanceId,
          conversationId: conversation.id,
          subject: { kind: "app", name: row.name }
        });
        return copied;
      })
  );
  return {
    name: row.name,
    title: assetTitle(
      options.configAssets.kinds.kinds,
      "app",
      row.name,
      row.config ?? {},
      context.locale
    ),
    ...(row.personTitle === undefined ? {} : { nameSetByPerson: true as const }),
    path,
    revision: row.revision,
    pageId: page.id,
    fileSetId: fileSet.id,
    number: fileSet.number
  };
}
