import { z } from "zod";
import { appPublishReview } from "../apps/app-publish-reach";
import {
  AppError,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type AppAudience
} from "@work-shape/catalyst-core";
import {
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ASSET_KIND,
  assetScopesEqual,
  type ConfigAssetRevisionRecord,
  type FileSet,
  type GuardrailFields,
  type GuardrailSubject,
  type JsonObject,
  type OperationBeforeEvent
} from "@work-shape/catalyst-core";
import type { AssetSyncItem } from "@work-shape/catalyst-api-contract";
import {
  GUARDRAIL_CHECKED_FIELD_MAX_CHARS,
  guardrailFieldOf,
  guardrailStringsOf,
  localizedStringSchema
} from "@work-shape/catalyst-config-schema";
import type { AssetFileInput } from "../assets/asset-files";
import { readFileSetFile } from "../pages/page-file-sets";
import { readDefinitionName } from "../asset-kinds/shared";
import { scopeOf } from "../assets/asset-target";
import { firstVersionOffering, type AgentPublishChecked } from "../approvals/agent-publish-review";
import { withGivenTools, type AgentGiveChecked } from "../assets/agent-drafts";
import type { AssetWorkflowOptions } from "../types";

// The before-events of the asset operations: `asset.before_write` for each asset a call saves
// or brings back, `app.before_publish`, `workflow.before_publish`, `data_store.before_publish`
// and `form_page.before_publish` for a revision a call makes live. Their guardrails read the
// asset's name and the text of its definition or its files. The text is handed to them and kept
// nowhere. A file that is no text is read by a pattern as its printable runs, so text hidden
// beside a NUL byte is still found and a photo adds next to nothing; a judge reads the long
// runs of an image or a font, and nothing it can judge where another file is no text
// (`GuardrailFilesField`).

const utf8 = new TextDecoder("utf-8", { fatal: true });

const displayTitleSchema = z.object({
  title: localizedStringSchema.optional(),
  displayName: localizedStringSchema.optional()
});

function writeTitle(config: unknown) {
  const parsed = displayTitleSchema.safeParse(config);
  const title = parsed.success ? (parsed.data.displayName ?? parsed.data.title) : undefined;
  return title === undefined ? {} : { title };
}

/** `asset.before_write` of one asset a call saves, from its definition or its files. */
export function assetWriteEvent(input: {
  kind: string;
  name: string;
  config?: unknown;
  files?: readonly AssetFileInput[];
}): OperationBeforeEvent {
  return {
    name: "asset.before_write",
    subject: { kind: input.kind, name: input.name, ...writeTitle(input.config) },
    checkable: () => ({
      name: input.name,
      content: filesField(
        input.config === undefined ? [] : guardrailStringsOf(input.config),
        (input.files ?? []).map((file) =>
          "text" in file ? { text: file.text } : readOf(Buffer.from(file.base64, "base64"))
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
  const subject: GuardrailSubject = { kind: input.kind, name: input.name };
  return {
    name: "asset.before_write",
    subject,
    checkable: async (): Promise<GuardrailFields> => {
      const written = await input.read();
      if (written) Object.assign(subject, writeTitle(written.config));
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
      subject: {
        kind: input.kind,
        id: revision.assetId,
        name: input.name,
        ...writeTitle(revision.config)
      },
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

/**
 * The input key a held agent publish keeps whether it publishes the first version, so the
 * approved call cannot publish a draft numbered like it, nor the first version of a draft
 * discarded meanwhile.
 */
export const AGENT_PUBLISH_HELD_KEY = "agentPublishFirstVersion";

const checkedAgentPublishes = new WeakMap<OperationBeforeEvent, AgentPublishChecked>();

/**
 * What the guardrails of an agent's publish read, from the events they were last asked: the
 * publish makes exactly that live, or nothing.
 */
export function agentPublishChecked(
  events: readonly OperationBeforeEvent[] | undefined,
  input: object
): AgentPublishChecked | undefined {
  const checked = events?.flatMap((event) => checkedAgentPublishes.get(event) ?? []).at(0);
  const approved: unknown = Reflect.get(input, AGENT_PUBLISH_HELD_KEY);
  return checked && typeof approved === "boolean"
    ? { ...checked, approvedFirstVersion: approved }
    : checked;
}

const checkedAgentGives = new WeakMap<OperationBeforeEvent, AgentGiveChecked>();

/** What the guardrails of `agents.give_tools` read, from the events they were last asked. */
export function agentGiveChecked(
  events: readonly OperationBeforeEvent[] | undefined
): AgentGiveChecked | undefined {
  return events?.flatMap((event) => checkedAgentGives.get(event) ?? []).at(0);
}

/**
 * `asset.before_write` and `agent.before_publish` of `agents.give_tools`, with the text of
 * what it makes live: the published agent at the revision the caller read, with the tools
 * added. A live agent that moved since is refused here, never checked as something else.
 */
export async function giveToolsEvents(
  options: RevisionOptions,
  input: { name: string; toolNames: readonly string[]; expectedLiveRevision: number }
): Promise<OperationBeforeEvent[]> {
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: "agent",
    name: input.name
  });
  if (
    !asset ||
    asset.status !== "active" ||
    asset.config === null ||
    asset.scope.kind !== "instance"
  )
    throw new AppError("NOT_FOUND", `Config agent '${input.name}' was not found`);
  if (asset.revision !== input.expectedLiveRevision)
    throw new AppError(
      "REVISION_CONFLICT",
      "The published agent changed. Read it again before giving it tools",
      { reason: "live_changed", currentRevision: asset.revision }
    );
  const config = withGivenTools(asset.config, input.toolNames);
  const write = assetWriteEvent({ kind: "agent", name: input.name, config });
  const publish: OperationBeforeEvent = {
    ...write,
    name: "agent.before_publish",
    subject: { ...write.subject, id: asset.id }
  };
  checkedAgentGives.set(publish, { liveRevision: asset.revision });
  return [write, publish];
}

/** The publish event of each kind that has one. */
const PUBLISH_EVENTS: Readonly<Record<string, OperationBeforeEvent["name"]>> = {
  app: "app.before_publish",
  [WORKFLOW_ASSET_KIND]: "workflow.before_publish",
  [DATA_STORE_ASSET_KIND]: "data_store.before_publish",
  // The kind of the capability `outside-forms` (EW-9c).
  form_page: "form_page.before_publish"
};

/**
 * `app.before_publish`, `workflow.before_publish`, `data_store.before_publish` or
 * `form_page.before_publish` of the revision a publish makes live, with the text of that
 * revision: a Data Store's are its migrations. Another kind has no publish event yet.
 */
export async function publishEvents(
  options: RevisionOptions,
  input: RevisionAddress,
  actor?: AuthenticatedIdentity
): Promise<OperationBeforeEvent[]> {
  if (input.kind === "agent") {
    const asset = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: "agent",
      name: input.name
    });
    if (
      !asset ||
      asset.status !== "active" ||
      !assetScopesEqual(asset.scope, scopeOf(input.workspaceId))
    )
      throw new AppError("NOT_FOUND", `Config agent '${input.name}' was not found`);
    const draft = await options.stores.agentProposals.get({
      clientInstanceId: options.clientInstanceId,
      agentId: asset.id
    });
    // A first version without a draft is published as it is stored (access check 11).
    const firstVersion =
      !draft && (await firstVersionOffering(options, asset, input.revision)) !== undefined;
    // A publish of a revision its guardrails cannot read is refused here, never let through
    // unchecked: the draft could reach that revision before the publish runs.
    if (!firstVersion && draft?.revision !== input.revision)
      throw new AppError(
        "REVISION_CONFLICT",
        "The agent draft changed. Read it again before publishing",
        { reason: "draft_changed" }
      );
    const config = firstVersion ? (asset.config ?? {}) : (draft?.config ?? {});
    const write = assetWriteEvent({ kind: "agent", name: input.name, config });
    // The publish names its agent and the workspace that owns it: the shipped publish guardrail
    // holds the publish of a workspace's agent and not the instance's own (WS-PUB-1b).
    const publish: OperationBeforeEvent = {
      ...write,
      name: "agent.before_publish",
      subject: {
        ...write.subject,
        id: asset.id,
        ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
      }
    };
    const held: OperationBeforeEvent = {
      ...publish,
      heldInput: () => ({ [AGENT_PUBLISH_HELD_KEY]: firstVersion })
    };
    checkedAgentPublishes.set(held, { revision: input.revision, firstVersion });
    return [write, held];
  }
  const name = PUBLISH_EVENTS[input.kind];
  if (name === undefined) {
    return [];
  }
  const revision = await callersRevision(options, input);
  const asset =
    input.kind === "app"
      ? await options.configAssets.store.getConfigAsset({
          clientInstanceId: options.clientInstanceId,
          kind: input.kind,
          name: input.name
        })
      : undefined;
  const kind = input.kind === "app" ? options.configAssets.kinds.get(input.kind) : undefined;
  const widening =
    asset && revision && kind?.publishReach
      ? appPublishReview(
          asset,
          kind,
          revision.config,
          input.audience,
          actor && !isAuthenticatedServicePrincipal(actor) ? getSubjectUserId(actor) : undefined
        ).publishWidens
      : undefined;
  if (!revision) {
    // Nothing of the caller's to make live: the publish itself refuses it.
    return [];
  }
  return [
    {
      name,
      subject: {
        kind: input.kind,
        id: revision.assetId,
        name: input.name,
        ...writeTitle(revision.config)
      },
      checkable: async (): Promise<GuardrailFields> => ({
        name: input.name,
        content: await revisionText(options, revision),
        ...(widening === undefined ? {} : { publish_widens: String(widening) })
      })
    }
  ];
}

/**
 * The fields of one stored revision as its write is read at `asset.before_write` or its
 * publish at the publish event: its name and its text. Nothing where the revision is gone or
 * belongs to another asset than the one named. For a test and a dry run, which keep nothing.
 */
export async function storedRevisionFields(
  options: RevisionOptions,
  input: { kind: string; name: string; revision: number; assetId?: string }
): Promise<GuardrailFields | undefined> {
  const revision = await options.configAssets.store.getConfigAssetRevision({
    clientInstanceId: options.clientInstanceId,
    kind: input.kind,
    name: input.name,
    revision: input.revision
  });
  if (
    !revision ||
    revision.config === null ||
    (input.assetId !== undefined && revision.assetId !== input.assetId)
  ) {
    return undefined;
  }
  return {
    name: input.name,
    content: await revisionText(options, { ...revision, config: revision.config })
  };
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
  audience?: AppAudience;
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
 * The texts given and the source files of a set, or `null` where their text is more than a
 * guardrail reads. Files are read one at a time, a file that is no text reduced to its
 * printable runs as it is read, so only text counts toward the limit: a Page of photos is read
 * whole.
 */
async function fileSetText(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores" | "pages">,
  texts: readonly string[],
  fileSet: FileSet
): Promise<GuardrailFields[string]> {
  let chars = texts.reduce((sum, text) => sum + text.length, 0);
  const files: FileRead[] = [];
  for (const file of fileSet.sourceFiles) {
    const read = readOf(await readFileSetFile(options, fileSet, "src", file));
    chars += "text" in read ? read.text.length : 0;
    // A field longer than a check reads is not read in part: the rest need not be read.
    if (chars > GUARDRAIL_CHECKED_FIELD_MAX_CHARS) return null;
    files.push(read);
  }
  return filesField(texts, files);
}

/**
 * One file as a guardrail reads it: its text, or, where it is no text, its printable runs for
 * a pattern and, of an image or a font, the long ones for a judge.
 */
type FileRead = { text: string } | { runs: string[]; judgeRuns?: string[] };

const utf16 = {
  le: new TextDecoder("utf-16le", { fatal: true }),
  be: new TextDecoder("utf-16be", { fatal: true })
};

/** The bytes UTF-16 without a byte order mark is told by, at the start of a file. */
const UTF16_SNIFF_BYTES = 1024;

/**
 * A file's text where it is UTF-8 without a NUL, as a read answers it, or UTF-16, as exports
 * of Windows tools and some APIs are: with its byte order mark, or without one where the NUL
 * bytes of its start sit at one parity; else its printable runs.
 */
function readOf(bytes: Uint8Array): FileRead {
  const decoder =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? utf16.le
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? utf16.be
        : utf16WithoutMark(bytes);
  try {
    if (decoder) return { text: decoder.decode(bytes) };
    if (!bytes.includes(0)) return { text: utf8.decode(bytes) };
  } catch {
    // Not the text it starts like: read as bytes.
  }
  return {
    runs: printableRuns(bytes, PATTERN_RUN_MIN_CHARS),
    ...(isImageOrFont(bytes) ? { judgeRuns: printableRuns(bytes, JUDGE_RUN_MIN_CHARS) } : {})
  };
}

/**
 * The share of the bytes at one parity of the start that are NUL, at least, and at the other,
 * at most, for UTF-16 without a byte order mark. Text of Latin letters has a NUL in every other
 * byte; a letter outside Latin-1, as the 'Ł' of a Polish name, has none there, and an image's
 * NUL bytes sit at both parities alike.
 */
const UTF16_NUL_SHARE_MIN = 0.9;
const UTF16_NUL_SHARE_MAX = 0.1;

/**
 * The decoder of UTF-16 without a byte order mark: the NUL bytes of its start sit in the second
 * byte of each pair in little-endian order and in the first in big-endian.
 */
function utf16WithoutMark(bytes: Uint8Array): TextDecoder | undefined {
  const length = Math.min(bytes.length, UTF16_SNIFF_BYTES);
  if (length < 4 || length % 2 !== 0) return undefined;
  const pairs = length / 2;
  const nulShareAt = (parity: 0 | 1) => {
    let nuls = 0;
    for (let index = parity; index < length; index += 2) {
      if (bytes[index] === 0) nuls += 1;
    }
    return nuls / pairs;
  };
  const even = nulShareAt(0);
  const odd = nulShareAt(1);
  if (odd >= UTF16_NUL_SHARE_MIN && even <= UTF16_NUL_SHARE_MAX) return utf16.le;
  if (even >= UTF16_NUL_SHARE_MIN && odd <= UTF16_NUL_SHARE_MAX) return utf16.be;
  return undefined;
}

/** The shortest printable run of a file that is no text a pattern reads, as `strings` does. */
const PATTERN_RUN_MIN_CHARS = 4;
/**
 * The shortest printable run of an image or a font a judge reads. A photo's bytes hold one
 * this long once in some ten million bytes; text put into the file holds them throughout.
 */
const JUDGE_RUN_MIN_CHARS = 16;

/**
 * The field of a definition's texts and some files. Where a file is no text, a pattern reads
 * its printable runs and a judge the long ones of an image or a font; a file that is no text
 * and neither leaves a judge nothing it can be told the content of.
 */
function filesField(texts: readonly string[], files: readonly FileRead[]): GuardrailFields[string] {
  const read = [...texts, ...files.flatMap((file) => ("text" in file ? [file.text] : []))];
  const binaries = files.flatMap((file) => ("runs" in file ? [file] : []));
  if (binaries.length === 0) {
    return guardrailFieldOf(read);
  }
  const judgeable = binaries.every((file) => file.judgeRuns !== undefined);
  return {
    pattern: guardrailFieldOf([...read, ...binaries.flatMap((file) => file.runs)]),
    judge: guardrailFieldOf([
      ...read,
      ...(judgeable ? binaries.flatMap((file) => file.judgeRuns ?? []) : [])
    ]),
    ...(judgeable ? {} : { notJudgeable: true as const })
  };
}

/** The runs of printable ASCII, tab and line ends included, of at least `min` characters. */
function printableRuns(bytes: Uint8Array, min: number): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const runs: string[] = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    const byte = buffer[index];
    const printable =
      byte !== undefined &&
      ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d);
    if (printable) continue;
    if (index - start >= min) runs.push(buffer.toString("latin1", start, index));
    start = index + 1;
  }
  return runs;
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
