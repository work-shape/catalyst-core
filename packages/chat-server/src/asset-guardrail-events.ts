import {
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  type ConfigAssetRevisionRecord,
  type FileSet,
  type GuardrailFields,
  type JsonObject,
  type OperationBeforeEvent
} from "@vivd-catalyst/core";
import type { AssetSyncItem } from "@vivd-catalyst/api-contract";
import {
  GUARDRAIL_CHECKED_FIELD_MAX_CHARS,
  guardrailFieldOf,
  guardrailStringsOf
} from "@vivd-catalyst/config-schema";
import { readSourceFiles, type AssetFileInput } from "./asset-files";
import { readDefinitionName } from "./asset-kinds/shared";
import type { AssetWorkflowOptions } from "./types";

// The before-events of the asset operations: `asset.before_write` for each asset a call saves
// or brings back, `app.before_publish`, `workflow.before_publish` and
// `data_store.before_publish` for a revision a call makes live. Their guardrails read the
// asset's name and the text of its definition or its files. The text is handed to them and kept
// nowhere. A file that is no text, such as an image, is not read: the content is then unread,
// which a guardrail that stops or holds answers as a match.

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** `asset.before_write` of one asset a call saves, from its definition or its files. */
export function assetWriteEvent(input: {
  kind: string;
  name: string;
  config?: unknown;
  files?: readonly AssetFileInput[];
}): OperationBeforeEvent {
  return {
    name: "asset.before_write",
    subject: { kind: input.kind, name: input.name },
    checkable: () => {
      const texts = input.config === undefined ? [] : guardrailStringsOf(input.config);
      for (const file of input.files ?? []) {
        const text = "text" in file ? file.text : decodedText(file.base64);
        if (text === undefined) return { name: input.name, content: null };
        texts.push(text);
      }
      return { name: input.name, content: guardrailFieldOf(texts) };
    }
  };
}

/**
 * `asset.before_write` of an asset a call writes from a file set it copies, as an App is
 * written from a Page: its definition and the files of the set as the write stores them.
 * `read` answers nothing where there is no set, which the write itself refuses.
 */
export function fileSetWriteEvent(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores" | "pages">,
  input: {
    kind: string;
    name: string;
    read(): Promise<{ config: JsonObject; fileSet: FileSet } | undefined>;
  }
): OperationBeforeEvent {
  return {
    name: "asset.before_write",
    subject: { kind: input.kind, name: input.name },
    checkable: async (): Promise<GuardrailFields> => {
      const written = await input.read();
      return written
        ? {
            name: input.name,
            content: await fileSetText(options, guardrailStringsOf(written.config), written.fileSet)
          }
        : { name: input.name };
    }
  };
}

/**
 * `asset.before_write` of a revert, with the text of the earlier revision it writes again: a
 * revision kept from before a guardrail existed is read like a new write.
 */
export async function revertWriteEvents(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores" | "pages">,
  input: { kind: string; name: string; revision: number }
): Promise<OperationBeforeEvent[]> {
  const revision = await options.configAssets.store.getConfigAssetRevision({
    clientInstanceId: options.clientInstanceId,
    kind: input.kind,
    name: input.name,
    revision: input.revision
  });
  if (!revision || revision.config === null) {
    // Nothing to bring back: the revert itself refuses it.
    return [];
  }
  const { config } = revision;
  return [
    {
      name: "asset.before_write",
      subject: { kind: input.kind, id: revision.assetId, name: input.name },
      checkable: async (): Promise<GuardrailFields> => ({
        name: input.name,
        content: await revisionText(options, { ...revision, config })
      })
    }
  ];
}

/** `asset.before_write` of each asset a sync saves. A delete writes no content. */
export function syncWriteEvents(input: {
  items: readonly AssetSyncItem[];
}): OperationBeforeEvent[] {
  return input.items.flatMap((item) =>
    item.type === "put"
      ? [
          assetWriteEvent({
            kind: item.kind,
            name: readDefinitionName(item.config) ?? "",
            config: item.config
          })
        ]
      : []
  );
}

/** The publish event of each kind that has one. */
const PUBLISH_EVENTS: Readonly<Record<string, OperationBeforeEvent["name"]>> = {
  app: "app.before_publish",
  [WORKFLOW_ASSET_KIND]: "workflow.before_publish",
  [DATA_STORE_ASSET_KIND]: "data_store.before_publish"
};

/**
 * `app.before_publish`, `workflow.before_publish` or `data_store.before_publish` of the
 * revision a publish makes live, with the text of that revision: a Data Store's are its
 * migrations. Another kind has no publish event yet.
 */
export async function publishEvents(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores" | "pages">,
  input: { kind: string; name: string; revision: number }
): Promise<OperationBeforeEvent[]> {
  const name = PUBLISH_EVENTS[input.kind];
  if (name === undefined) {
    return [];
  }
  const revision = await options.configAssets.store.getConfigAssetRevision({
    clientInstanceId: options.clientInstanceId,
    kind: input.kind,
    name: input.name,
    revision: input.revision
  });
  if (!revision || revision.config === null) {
    // Nothing to make live: the publish itself refuses it.
    return [];
  }
  const { config } = revision;
  return [
    {
      name,
      subject: { kind: input.kind, id: revision.assetId, name: input.name },
      checkable: async (): Promise<GuardrailFields> => ({
        name: input.name,
        content: await revisionText(options, { ...revision, config })
      })
    }
  ];
}

/**
 * The text of one revision: its definition's strings and its source files, or `null` where its
 * files are more than a guardrail reads or one of them is no text.
 */
async function revisionText(
  options: Parameters<typeof publishEvents>[0],
  revision: Pick<ConfigAssetRevisionRecord, "assetId" | "fileSetId"> & { config: JsonObject }
): Promise<string | null> {
  const texts = guardrailStringsOf(revision.config);
  if (revision.fileSetId) {
    const fileSet = await options.stores.pages.getAssetFileSet({
      clientInstanceId: options.clientInstanceId,
      assetId: revision.assetId,
      fileSetId: revision.fileSetId
    });
    if (fileSet) {
      return fileSetText(options, texts, fileSet);
    }
  }
  return guardrailFieldOf(texts);
}

/**
 * The texts given and those of the source files of a set, or `null` where the files are more
 * than a guardrail reads or one of them is no text.
 */
async function fileSetText(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores" | "pages">,
  texts: readonly string[],
  fileSet: FileSet
): Promise<string | null> {
  // A character is at least one byte: a set this large cannot be read whole.
  const bytes = fileSet.sourceFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (bytes > GUARDRAIL_CHECKED_FIELD_MAX_CHARS * 4) {
    return null;
  }
  const { files, filesOmitted } = await readSourceFiles(options, fileSet);
  if (filesOmitted) {
    return null;
  }
  const read = [...texts];
  for (const file of files) {
    if (file.text === undefined) return null;
    read.push(file.text);
  }
  return guardrailFieldOf(read);
}

/** The text of a file sent as bytes, where it is UTF-8 without a NUL, as a read answers it. */
function decodedText(base64: string): string | undefined {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}
