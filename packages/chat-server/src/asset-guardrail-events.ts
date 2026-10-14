import {
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  assetScopesEqual,
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
import { scopeOf } from "./asset-read-workflow";
import type { AssetWorkflowOptions } from "./types";

// The before-events of the asset operations: `asset.before_write` for each asset a call saves
// or brings back, `app.before_publish`, `workflow.before_publish` and
// `data_store.before_publish` for a revision a call makes live. Their guardrails read the
// asset's name and the text of its definition or its files. The text is handed to them and kept
// nowhere. A file that is no text is read by a pattern as its bytes, so text hidden beside a
// NUL byte is still found; a judge is handed nothing of an image or a font, and nothing it can
// judge where another file is no text (`GuardrailFilesField`).

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
      content: filesField(
        input.config === undefined ? [] : guardrailStringsOf(input.config),
        (input.files ?? []).map((file) =>
          "text" in file ? { text: file.text } : contentOf(Buffer.from(file.base64, "base64"))
        )
      )
    })
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
  options: RevisionOptions,
  input: RevisionAddress
): Promise<OperationBeforeEvent[]> {
  const revision = await callersRevision(options, input);
  if (!revision) {
    // Nothing of the caller's to bring back: the revert itself refuses it.
    return [];
  }
  return [
    {
      name: "asset.before_write",
      subject: { kind: input.kind, id: revision.assetId, name: input.name },
      checkable: async (): Promise<GuardrailFields> => ({
        name: input.name,
        content: await revisionText(options, revision)
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
  options: RevisionOptions,
  input: RevisionAddress
): Promise<OperationBeforeEvent[]> {
  const name = PUBLISH_EVENTS[input.kind];
  if (name === undefined) {
    return [];
  }
  const revision = await callersRevision(options, input);
  if (!revision) {
    // Nothing of the caller's to make live: the publish itself refuses it.
    return [];
  }
  return [
    {
      name,
      subject: { kind: input.kind, id: revision.assetId, name: input.name },
      checkable: async (): Promise<GuardrailFields> => ({
        name: input.name,
        content: await revisionText(options, revision)
      })
    }
  ];
}

type RevisionOptions = Pick<
  AssetWorkflowOptions,
  "clientInstanceId" | "configAssets" | "stores" | "pages"
>;

/** A revision a call names, in the scope the call names: a workspace's, or the instance's. */
interface RevisionAddress {
  kind: string;
  name: string;
  revision: number;
  workspaceId?: string | undefined;
}

/**
 * The revision of the asset the call addresses, with a definition. Nothing where the asset of
 * that name belongs to another scope than the call's: the call refuses it as it does, and no
 * guardrail reads, judges or names another workspace's asset for it.
 */
async function callersRevision(
  options: RevisionOptions,
  input: RevisionAddress
): Promise<(ConfigAssetRevisionRecord & { config: JsonObject }) | undefined> {
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: input.kind,
    name: input.name
  });
  if (!asset || !assetScopesEqual(asset.scope, scopeOf(input.workspaceId))) {
    return undefined;
  }
  const revision = await options.configAssets.store.getConfigAssetRevision({
    clientInstanceId: options.clientInstanceId,
    kind: input.kind,
    name: input.name,
    revision: input.revision
  });
  if (!revision || revision.assetId !== asset.id || revision.config === null) {
    return undefined;
  }
  return { ...revision, config: revision.config };
}

/** The text of one revision: its definition's strings and its source files. */
async function revisionText(
  options: RevisionOptions,
  revision: Pick<ConfigAssetRevisionRecord, "assetId" | "fileSetId"> & { config: JsonObject }
): Promise<GuardrailFields[string]> {
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
 * The texts given and the source files of a set, or `null` where the files are more than a
 * guardrail reads.
 */
async function fileSetText(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores" | "pages">,
  texts: readonly string[],
  fileSet: FileSet
): Promise<GuardrailFields[string]> {
  // A character is at least one byte: a set this large cannot be read whole.
  const bytes = fileSet.sourceFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (bytes > GUARDRAIL_CHECKED_FIELD_MAX_CHARS * 4) {
    return null;
  }
  const { files, filesOmitted } = await readSourceFiles(options, fileSet);
  if (filesOmitted) {
    return null;
  }
  return filesField(
    texts,
    files.map((file) =>
      file.text !== undefined
        ? { text: file.text }
        : { bytes: Buffer.from(file.base64 ?? "", "base64") }
    )
  );
}

/** One file as a guardrail reads it: its text, or its bytes where it is no text. */
type FileContent = { text: string } | { bytes: Uint8Array };

/** A file's text where it is UTF-8 without a NUL, as a read answers it, or else its bytes. */
function contentOf(bytes: Uint8Array): FileContent {
  if (!bytes.includes(0)) {
    try {
      return { text: utf8.decode(bytes) };
    } catch {
      // Not UTF-8: read as bytes.
    }
  }
  return { bytes };
}

/**
 * The field of a definition's texts and some files. Where a file is no text, a pattern reads
 * its bytes as Latin-1 and a judge reads the text alone, or nothing where the file is neither
 * an image nor a font, which a judge cannot be told what it shows.
 */
function filesField(
  texts: readonly string[],
  files: readonly FileContent[]
): GuardrailFields[string] {
  const read = [...texts, ...files.flatMap((file) => ("text" in file ? [file.text] : []))];
  const binaries = files.flatMap((file) => ("bytes" in file ? [file.bytes] : []));
  if (binaries.length === 0) {
    return guardrailFieldOf(read);
  }
  const pattern = guardrailFieldOf([
    ...read,
    ...binaries.map((bytes) => Buffer.from(bytes).toString("latin1"))
  ]);
  if (pattern === null) return null;
  return { pattern, judge: binaries.every(isImageOrFont) ? guardrailFieldOf(read) : null };
}

/** The leading bytes of the image and font formats a page uses, whose pixels a judge skips. */
const IMAGE_AND_FONT_SIGNATURES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x00, 0x00, 0x01, 0x00], // ICO
  [0x77, 0x4f, 0x46, 0x46], // WOFF
  [0x77, 0x4f, 0x46, 0x32], // WOFF2
  [0x00, 0x01, 0x00, 0x00], // TrueType
  [0x4f, 0x54, 0x54, 0x4f] // OpenType
];

function isImageOrFont(bytes: Uint8Array): boolean {
  const startsWith = (signature: readonly number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  // WebP: a RIFF container of the form WEBP.
  const webp =
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[8 + index] === byte);
  return webp || IMAGE_AND_FONT_SIGNATURES.some(startsWith);
}
