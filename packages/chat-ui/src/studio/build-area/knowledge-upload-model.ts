import { KNOWLEDGE_TEXT_FORMATS, knowledgeDocumentFormatOf } from "@work-shape/catalyst-core";
import type { TranslationKey } from "../../shared/i18n";
import { KNOWLEDGE_ADD_LIMITS, KNOWLEDGE_ADD_REFUSALS } from "./knowledge-base-model";

// Uploading files from the person's device into a Knowledge Base: which files the picker
// offers, which a file is refused for before it is sent, and the queue of one dialog. Each file
// is its own call with its own idempotency key, so one that fails leaves the others added, and
// Retry sends only the failed ones again. A call that got no answer keeps its key, so a call
// whose answer was lost is answered by its run and never adds twice; a call the instance
// answered gets a new key, since its run would only answer the same failure again.

/**
 * What a refused upload says, by the reason the instance named: those of an add, and the
 * refusal of an upload the policy would hold for an approval, which it cannot wait for.
 */
export const KNOWLEDGE_UPLOAD_REFUSALS: Partial<Record<string, TranslationKey>> = {
  ...KNOWLEDGE_ADD_REFUSALS,
  knowledge_file_too_large: "knowledge.addTooLarge",
  approval_unavailable: "knowledge.uploadApprovalRefused",
  confirmation_required: "knowledge.uploadApprovalRefused"
};

/** What the picker offers for each format: its extensions and media type. */
const FORMAT_ACCEPT: Record<string, readonly string[]> = {
  txt: [".txt", "text/plain"],
  markdown: [".md", ".markdown", "text/markdown"],
  pdf: [".pdf", "application/pdf"],
  docx: [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
};

/** How a format is named in a sentence. */
const FORMAT_NAMES: Record<string, string> = {
  txt: "TXT",
  markdown: "Markdown",
  pdf: "PDF",
  docx: "DOCX"
};

/**
 * The formats the instance reads, as the Knowledge Base's state names them. Until it answered,
 * or from an instance that does not say, the text formats every instance reads.
 */
export function uploadFormats(named: readonly string[] | undefined): readonly string[] {
  const known = named?.filter((format) => format in FORMAT_ACCEPT) ?? [];
  return known.length > 0 ? known : KNOWLEDGE_TEXT_FORMATS;
}

/** The picker's `accept`: the extensions and media types of the formats the instance reads. */
export function uploadAccept(formats: readonly string[]): string {
  return formats.flatMap((format) => FORMAT_ACCEPT[format] ?? []).join(",");
}

/** The formats as a list for a sentence: "TXT, Markdown and PDF" / "TXT, Markdown und PDF". */
export function uploadFormatList(formats: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(
    formats.map((format) => FORMAT_NAMES[format] ?? format)
  );
}

/**
 * Whether a chosen file is sent, and the reason it is not: a format no Knowledge Base reads,
 * one this instance does not read, or a file over the size limit. The call refuses all three.
 */
export function uploadableFile(
  file: { name: string; type: string; size: number },
  formats: readonly string[]
): { uploadable: true } | { uploadable: false; reason: TranslationKey } {
  const format = knowledgeDocumentFormatOf({
    filename: file.name,
    ...(file.type ? { mimeType: file.type } : {})
  });
  if (format === undefined || !formats.includes(format)) {
    return { uploadable: false, reason: "knowledge.uploadFormatRefused" };
  }
  if (file.size > KNOWLEDGE_ADD_LIMITS.bytes) {
    return { uploadable: false, reason: "knowledge.addTooLarge" };
  }
  return { uploadable: true };
}

/** One chosen file in the dialog's queue. */
export interface UploadItem<Source = File> {
  /** Stable for the dialog: the row's key. */
  id: string;
  /** The idempotency key of the next call of this file. */
  key: string;
  name: string;
  file: Source;
  state: "waiting" | "uploading" | "added" | "failed";
  /** Why it failed: a text key, or the instance's own sentence. */
  failure?: { key: TranslationKey } | { message: string };
  /** The call that failed got no answer: whether it ran is unknown, so Retry keeps its key. */
  unanswered?: true;
}

/**
 * Adds chosen files to the queue. One the call would refuse is failed at once with its reason
 * and is never sent; the rest wait for their turn.
 */
export function queueUploads<Source extends { name: string; type: string; size: number }>(
  queue: readonly UploadItem<Source>[],
  files: readonly Source[],
  formats: readonly string[],
  newId: () => string
): UploadItem<Source>[] {
  return [
    ...queue,
    ...files.map((file): UploadItem<Source> => {
      const fit = uploadableFile(file, formats);
      const id = newId();
      return fit.uploadable
        ? { id, key: id, name: file.name, file, state: "waiting" }
        : { id, key: id, name: file.name, file, state: "failed", failure: { key: fit.reason } };
    })
  ];
}

/** The next file to send: one at a time, in the order they were chosen. */
export function nextUpload<Source>(
  queue: readonly UploadItem<Source>[]
): UploadItem<Source> | undefined {
  if (queue.some((item) => item.state === "uploading")) return undefined;
  return queue.find((item) => item.state === "waiting");
}

/** The queue with one item changed. */
export function settleUpload<Source>(
  queue: readonly UploadItem<Source>[],
  id: string,
  change: Pick<UploadItem<Source>, "state" | "failure" | "unanswered">
): UploadItem<Source>[] {
  return queue.map((item) =>
    item.id !== id
      ? item
      : {
          id: item.id,
          key: item.key,
          name: item.name,
          file: item.file,
          state: change.state,
          ...(change.failure ? { failure: change.failure } : {}),
          ...(change.unanswered ? { unanswered: true as const } : {})
        }
  );
}

/**
 * Sends a failed file again. A call that got no answer keeps its key: if it ran, its run
 * answers and the file is not added twice. A call the instance answered takes a new key, so
 * the file is really sent again. A file refused before it was sent stays refused, and an added
 * one is never sent again.
 */
export function retryUpload<Source extends { name: string; type: string; size: number }>(
  queue: readonly UploadItem<Source>[],
  id: string,
  formats: readonly string[],
  newId: () => string
): UploadItem<Source>[] {
  return queue.map((item) => {
    if (item.id !== id || item.state !== "failed") return item;
    if (!uploadableFile(item.file, formats).uploadable) return item;
    return {
      id: item.id,
      key: item.unanswered ? item.key : newId(),
      name: item.name,
      file: item.file,
      state: "waiting"
    };
  });
}
