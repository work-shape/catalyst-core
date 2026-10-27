import { sha256Hex } from "@work-shape/catalyst-core/sha256";
import {
  AppError,
  fileSetFileObjectKey,
  isFileSetId,
  readObjectBytes,
  type ClientInstanceId,
  type ObjectStorage,
  type OperationRunId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type {
  ClientInstanceCapabilityAssets,
  ClientInstanceCapabilityBrand,
  ClientInstanceCapabilityMail,
  ClientInstanceCapabilityPlatformStores,
  ClientInstanceCapabilityRecords,
  ClientInstanceCapabilityRunFiles
} from "@work-shape/catalyst-capability-sdk";
import type { WorkflowRunFiles } from "@work-shape/catalyst-workflows";
import {
  createClientBranding,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import { createInlineImageLoader, type MailSender } from "@work-shape/catalyst-mail";

// The ports one capability gets of the platform's records (ADR-0033): its own records, the
// Operation Runs of its own operations, the files of the Workflow runs those serve, the
// published revisions of its own asset kinds, the instance's mailer and how the instance
// presents itself outside.

type ScopedStores = Pick<
  ClientInstanceCapabilityPlatformStores,
  "records" | "operationRuns" | "runFiles" | "assets"
>;

export function capabilityStoresOf(input: {
  clientInstanceId: ClientInstanceId;
  capability: string;
  store: Pick<
    PlatformStores,
    "capabilityRecords" | "operationRuns" | "workflowRuns" | "configAssets" | "pages"
  >;
  /** The capability's async operations, known once it is created. */
  operations: () => ReadonlySet<string>;
  /** The asset kinds the capability brings, known once it is created; none where absent. */
  kinds?: () => ReadonlySet<string>;
  /** The `files` object store, where the instance has one: the file sets of assets lie there. */
  objects?: ObjectStorage;
  /**
   * The files of Workflow runs, once the process has its store of files. Absent where the
   * instance runs no Workflows or keeps no files: the capability then gets no `runFiles`.
   */
  runFiles?: () => WorkflowRunFiles | undefined;
}): ScopedStores {
  const { clientInstanceId, capability, store } = input;
  const own = { clientInstanceId, capability };
  const records: ClientInstanceCapabilityRecords = {
    create: (call) => store.capabilityRecords.create({ ...call, ...own }),
    get: (call) => store.capabilityRecords.get({ ...call, ...own }),
    getByKey: (call) => store.capabilityRecords.getByKey({ ...call, ...own }),
    update: (call) => store.capabilityRecords.update({ ...call, ...own }),
    claim: (call) => store.capabilityRecords.claim({ ...call, ...own }),
    deleteExpired: (call) => store.capabilityRecords.deleteExpired({ ...call, ...own })
  };
  async function ownRun(id: OperationRunId) {
    const run = await store.operationRuns.get({ clientInstanceId, id });
    return run && input.operations().has(run.operation) ? run : undefined;
  }
  function requireOwnKind(kind: string) {
    if (!input.kinds?.().has(kind)) {
      throw new AppError("FORBIDDEN", `The capability brings no asset kind '${kind}'`);
    }
  }
  const assets: ClientInstanceCapabilityAssets = {
    async listPublished({ kind, names, afterName, limit }) {
      requireOwnKind(kind);
      const found = await store.configAssets.listPublishedConfigAssets({
        clientInstanceId,
        kind,
        ...(names ? { names } : {}),
        ...(afterName === undefined ? {} : { afterName }),
        limit
      });
      return found.flatMap((asset) =>
        asset.publishedRevision === undefined || asset.publishedConfig === undefined
          ? []
          : [
              {
                id: asset.id,
                kind: asset.kind,
                name: asset.name,
                scope: asset.scope,
                revision: asset.publishedRevision,
                config: asset.publishedConfig,
                ...(asset.publishedFileSetId ? { fileSetId: asset.publishedFileSetId } : {})
              }
            ]
      );
    },
    async readFiles({ kind, name, fileSetId }) {
      requireOwnKind(kind);
      const asset = await store.configAssets.getConfigAsset({ clientInstanceId, kind, name });
      const fileSet =
        asset?.status === "active" && isFileSetId(fileSetId)
          ? await store.pages.getAssetFileSet({ clientInstanceId, assetId: asset.id, fileSetId })
          : undefined;
      if (!fileSet) {
        throw new AppError("NOT_FOUND", `No file set of ${kind} '${name}' has this id`);
      }
      const objects = input.objects;
      if (!objects) {
        throw new AppError("CONFLICT", "This instance has no store of files", {
          reason: "files_unavailable"
        });
      }
      return Promise.all(
        fileSet.sourceFiles.map(async (file) => {
          const bytes = await readObjectBytes(
            objects,
            fileSetFileObjectKey(fileSet.owner, fileSet.id, "src", file.path)
          );
          if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) {
            throw new AppError("INTERNAL", "A stored file does not match its file set");
          }
          return { path: file.path, bytes };
        })
      );
    }
  };
  return {
    records,
    assets,
    operationRuns: {
      get: ownRun,
      async workflowOf(id) {
        const run = await ownRun(id);
        if (run?.origin.kind !== "workflow") return undefined;
        const workflowRun = await store.workflowRuns.readRun({
          clientInstanceId,
          id: run.origin.workflowRunId
        });
        if (!workflowRun) return undefined;
        const workflow = await store.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "workflow",
          name: workflowRun.workflow
        });
        return workflow ? { name: workflow.name, scope: workflow.scope } : undefined;
      },
      async finish({ id, end }) {
        if (end.status !== "done" && end.status !== "failed") {
          throw new AppError("VALIDATION_FAILED", "A capability ends its runs as done or failed");
        }
        const run = await ownRun(id);
        if (!run) {
          throw new AppError("NOT_FOUND", "No run of this capability's operations has this id");
        }
        return store.operationRuns.finish({ clientInstanceId, id: run.id, end });
      }
    },
    ...(input.runFiles ? { runFiles: runFilesPort(input.runFiles) } : {})
  };

  function runFilesPort(
    files: () => WorkflowRunFiles | undefined
  ): ClientInstanceCapabilityRunFiles {
    return {
      async create({ operationRunId, filename, mimeType, content }) {
        const run = await ownRun(operationRunId);
        if (!run) {
          throw new AppError("NOT_FOUND", "No run of this capability's operations has this id");
        }
        if (run.status !== "running") {
          throw new AppError("CONFLICT", "The run has ended, so it keeps no file", {
            reason: "run_ended"
          });
        }
        if (run.origin.kind !== "workflow") {
          throw new AppError("FORBIDDEN", "Only a run that a Workflow step started keeps files");
        }
        const workflowRun = await store.workflowRuns.readRun({
          clientInstanceId,
          id: run.origin.workflowRunId
        });
        const keeper = files();
        if (!workflowRun || !keeper) {
          throw new AppError("CONFLICT", "This instance keeps no files of Workflow runs", {
            reason: "files_unavailable"
          });
        }
        return keeper.create({ run: workflowRun, filename, mimeType, content });
      }
    };
  }
}

export function createCapabilityMail(input: {
  /** The instance's mailer, once the instance has made it. */
  sender: () => Pick<MailSender, "send"> | undefined;
  defaultFromName: string;
}): ClientInstanceCapabilityMail {
  return {
    available: () => input.sender() !== undefined,
    async send(message, context) {
      const sender = input.sender();
      if (!sender) return { ok: false, reason: "no_mail" };
      const result = await sender.send(
        {
          template: "workflow-message",
          params: {
            subject: message.subject,
            markdown: message.markdown,
            sentBy: { kind: "workflow", workflowName: message.workflowName }
          },
          to: [
            message.to.name
              ? { email: message.to.email, displayLabel: message.to.name }
              : { email: message.to.email }
          ],
          fromName: message.fromName ?? input.defaultFromName,
          locale: message.locale
        },
        context
      );
      if (result.ok) return { ok: true };
      return {
        ok: false,
        reason: result.failure ?? "rejected",
        ...(result.providerCode ? { providerCode: result.providerCode } : {})
      };
    }
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

/**
 * The instance's name, accent colour and logo as a capability shows them outside the instance.
 * The logo is read from where the release config points, as the mails read it.
 */
export function createCapabilityBrand(
  config: ClientInstanceConfig,
  /** Tests read the logo through their own reader. */
  options: Pick<Parameters<typeof createInlineImageLoader>[0], "fetch"> = {}
): ClientInstanceCapabilityBrand {
  const branding = createClientBranding(config);
  // A logo at a path of the instance resolves against the instance's address, with or without mail.
  const appUrl = config.infrastructure.mail?.appUrl ?? config.instance.publicUrl;
  const logo = branding.logoUrl
    ? createInlineImageLoader({
        url: branding.logoUrl,
        ...(appUrl ? { baseUrl: appUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        contentId: "logo"
      })
    : undefined;
  return {
    name: branding.clientName,
    ...(branding.accentColor && HEX_COLOR.test(branding.accentColor)
      ? { accentColor: branding.accentColor }
      : {}),
    async logo() {
      const image = await logo?.();
      return image ? { contentType: image.contentType, content: image.content } : undefined;
    }
  };
}
