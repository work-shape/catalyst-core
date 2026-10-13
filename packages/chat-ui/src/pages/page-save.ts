import type { TranslationContextValue } from "../i18n";
import type { PageBuildError, Surface, SurfaceOf } from "../surface/surface";

// What the thread knows of a Page: the calls of `page.save`. A call names the Page, and its
// answer is the revision it stored or the findings of the build that refused it.

export const PAGE_SAVE_TOOL_NAME = "page.save";

/**
 * What a stored save did to the App the conversation is about, where the Page is that App's:
 * the App's draft revision it wrote, or why it wrote none.
 */
type PageSaveApp =
  | { title: string; saved: true; revision: number }
  | { title: string; saved: false; message: string };

/** How one call of `page.save` stands. */
export type PageSave =
  | { state: "building"; name: string | undefined }
  | {
      state: "built";
      name: string | undefined;
      pageId: string;
      fileSetId: string;
      number: number;
      app?: PageSaveApp;
    }
  | { state: "errors"; name: string | undefined; errors: PageBuildError[] }
  | { state: "failed"; name: string | undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBuildErrors(value: unknown): PageBuildError[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item): PageBuildError[] =>
    isRecord(item) && typeof item.file === "string" && typeof item.message === "string"
      ? [
          {
            file: item.file,
            message: item.message,
            ...(typeof item.line === "number" ? { line: item.line } : {})
          }
        ]
      : []
  );
}

function readSaveApp(value: unknown): PageSaveApp | undefined {
  if (!isRecord(value) || typeof value.title !== "string") {
    return undefined;
  }
  if (value.saved === true && typeof value.revision === "number") {
    return { title: value.title, saved: true, revision: value.revision };
  }
  return value.saved === false && typeof value.message === "string"
    ? { title: value.title, saved: false, message: value.message }
    : undefined;
}

/**
 * Reads one call of `page.save`. `result` is absent while the call runs. An answer that is
 * neither a revision nor a list of findings is a call that failed.
 */
export function readPageSave(input: {
  args: unknown;
  result: unknown;
  failed?: boolean;
}): PageSave {
  const name =
    isRecord(input.args) && typeof input.args.name === "string" && input.args.name.trim() !== ""
      ? input.args.name.trim()
      : undefined;
  if (input.failed) {
    return { state: "failed", name };
  }
  if (input.result === undefined) {
    return { state: "building", name };
  }
  const container = isRecord(input.result) ? input.result : {};
  const output = isRecord(container.output) ? container.output : container;
  const { pageId, fileSetId, number } = output;
  if (
    typeof pageId === "string" &&
    typeof fileSetId === "string" &&
    typeof number === "number" &&
    Number.isInteger(number) &&
    number > 0
  ) {
    const app = readSaveApp(output.app);
    return { state: "built", name, pageId, fileSetId, number, ...(app ? { app } : {}) };
  }
  const errors = readBuildErrors(output.errors);
  return errors ? { state: "errors", name, errors } : { state: "failed", name };
}

/** The surface of one saved revision. Its key names the revision, so each one opens once. */
export function pageSurface(
  conversationId: string,
  save: Extract<PageSave, { state: "built" }>,
  t: TranslationContextValue["t"]
): SurfaceOf<"page"> {
  return {
    kind: "page",
    key: `page:${save.pageId}:${save.fileSetId}`,
    title: save.name ?? t("pages.unnamed"),
    subtitle: t("pages.revision", { number: save.number }),
    conversationId,
    pageId: save.pageId,
    fileSetId: save.fileSetId
  };
}

/** One line for a number of build errors. */
export function buildErrorCountLabel(count: number, t: TranslationContextValue["t"]): string {
  return count === 1 ? t("pages.buildErrorsOne") : t("pages.buildErrors", { count });
}

/** Where a finding lies: the file, and the line when the build named one. */
export function buildErrorPlace(error: PageBuildError, t: TranslationContextValue["t"]): string {
  return error.line === undefined
    ? error.file
    : t("pages.errorPlace", { file: error.file, line: error.line });
}

interface RunToolCall {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
}

/** The surface a Page's first save takes while it builds. One per call. */
export function pageBuildingSurface(
  callId: string,
  save: { name: string | undefined },
  t: TranslationContextValue["t"]
): SurfaceOf<"page_building"> {
  return {
    kind: "page_building",
    key: `page-building:${callId}`,
    title: save.name ?? t("pages.unnamed"),
    callId
  };
}

/** What a run's saves of Pages may change in the surface slot. */
type PageRunSurface = SurfaceOf<"page"> | SurfaceOf<"page_building">;

/**
 * What the calls of `page.save` in a run ask of the surface slot, in the order they were made.
 *
 * - A save that starts takes the slot with its building Page, so the surface opens at the
 *   agent's first write, unless the slot shows a revision of the same Page, which stays until
 *   the new one replaces it, or the conversation is about an App: the save writes the App's
 *   draft, which is shown as the App.
 * - A stored revision opens, except one that wrote the draft of the App the conversation is
 *   about: the App's surface shows it.
 * - Findings go under the revision of the same Page that is shown, or onto its building Page.
 *
 * `current` is the surface the slot holds. Each start and each answer counts once: `handled`
 * keeps the ones that did.
 */
export function pageSurfaceAfterRunCalls(input: {
  conversationId: string;
  parts: readonly RunToolCall[];
  handled: Set<string>;
  current: Surface | undefined;
  /** The conversation is about an App. */
  aboutApp?: boolean;
  t: TranslationContextValue["t"];
}): PageRunSurface | undefined {
  let next: PageRunSurface | undefined;
  for (const part of input.parts) {
    const callId = part.toolCallId;
    if (
      part.type !== "tool_call" ||
      part.toolName !== PAGE_SAVE_TOOL_NAME ||
      callId === undefined ||
      input.handled.has(callId)
    ) {
      continue;
    }
    const save = readPageSave({
      args: part.input,
      result: part.state === "output_available" ? part.output : undefined,
      failed: part.state === "output_error"
    });
    const shown = next ?? input.current;
    const building = shown?.kind === "page_building" && shown.callId === callId ? shown : undefined;
    if (save.state === "building") {
      const startKey = `${callId}:start`;
      if (input.handled.has(startKey)) {
        continue;
      }
      input.handled.add(startKey);
      const samePageShown =
        shown?.kind === "page" && save.name !== undefined && shown.title === save.name;
      if (!input.aboutApp && !samePageShown) {
        next = pageBuildingSurface(callId, save, input.t);
      }
      continue;
    }
    input.handled.add(callId);
    if (save.state === "built") {
      // A save that wrote the App's draft is seen as the App. Its building Page, where one was
      // shown, gives way to the revision rather than stay on.
      if (save.app === undefined || building) {
        next = pageSurface(input.conversationId, save, input.t);
      }
      continue;
    }
    if (building) {
      next =
        save.state === "errors"
          ? { ...building, buildErrors: save.errors }
          : { ...building, failed: true };
      continue;
    }
    if (
      save.state === "errors" &&
      shown?.kind === "page" &&
      save.name !== undefined &&
      shown.title === save.name
    ) {
      next = { ...shown, buildErrors: save.errors };
    }
  }
  return next;
}
