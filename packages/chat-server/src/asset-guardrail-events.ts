import {
  type ConfigAssetRevisionRecord,
  type GuardrailFields,
  type JsonObject,
  type OperationBeforeEvent
} from "@vivd-catalyst/core";
import type { AssetSyncItem } from "@vivd-catalyst/api-contract";
import { GUARDRAIL_CHECKED_FIELD_MAX_CHARS } from "@vivd-catalyst/config-schema";
import { readSourceFiles, type AssetFileInput } from "./asset-files";
import { readDefinitionName } from "./asset-kinds/shared";
import type { AssetWorkflowOptions } from "./types";

// The before-events of the asset operations: `asset.before_write` for each asset a call saves,
// `app.before_publish` and `workflow.before_publish` for a revision a call makes live. Their
// guardrails read the asset's name and the text of its definition or its files. The text is
// handed to them and kept nowhere.

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
    checkable: () => ({
      name: input.name,
      content: textOf([
        ...(input.config === undefined ? [] : stringsOf(input.config)),
        ...(input.files ?? []).flatMap((file) => {
          const text = "text" in file ? file.text : decodedText(file.base64);
          return text === undefined ? [] : [text];
        })
      ])
    })
  };
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

/**
 * `app.before_publish` or `workflow.before_publish` of the revision a publish makes live, with
 * the text of that revision. Another kind has no publish event yet.
 */
export async function publishEvents(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores" | "pages">,
  input: { kind: string; name: string; revision: number }
): Promise<OperationBeforeEvent[]> {
  const name =
    input.kind === "app"
      ? "app.before_publish"
      : input.kind === "workflow"
        ? "workflow.before_publish"
        : undefined;
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
 * files are more than a guardrail reads.
 */
async function revisionText(
  options: Parameters<typeof publishEvents>[0],
  revision: Pick<ConfigAssetRevisionRecord, "assetId" | "fileSetId"> & { config: JsonObject }
): Promise<string | null> {
  const texts = stringsOf(revision.config);
  if (revision.fileSetId) {
    const fileSet = await options.stores.pages.getAssetFileSet({
      clientInstanceId: options.clientInstanceId,
      assetId: revision.assetId,
      fileSetId: revision.fileSetId
    });
    if (fileSet) {
      // A character is at least one byte: a set this large cannot be read whole.
      const bytes = fileSet.sourceFiles.reduce((sum, file) => sum + file.bytes, 0);
      if (bytes > GUARDRAIL_CHECKED_FIELD_MAX_CHARS * 4) {
        return null;
      }
      const { files, filesOmitted } = await readSourceFiles(options, fileSet);
      if (filesOmitted) {
        return null;
      }
      for (const file of files) {
        if (file.text !== undefined) texts.push(file.text);
      }
    }
  }
  return textOf(texts);
}

/** Every string of a definition, keys and values, in document order. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...stringsOf(entry)]);
  }
  return [];
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

function textOf(texts: readonly string[]): string | null {
  const text = texts.join("\n");
  return text.length > GUARDRAIL_CHECKED_FIELD_MAX_CHARS ? null : text;
}
