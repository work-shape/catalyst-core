import type { TranslationContextValue } from "../../shared/i18n";
import type { PageBuildError, Surface, SurfaceOf } from "../../chat/surface/surface";

// What the thread knows of what an agent opened in the preview: the calls of `workspace.open`.
// A call names the file or folder, and its answer is the revision it built or the findings of
// the build that refused it.

/** The former name of `workspace.open`, whose calls stored conversations still hold. */
export const FORMER_OPEN_TOOL_NAME = "page.save";

/** The tools whose calls open a revision in the preview. */
const OPEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workspace.open",
  "app.edit",
  FORMER_OPEN_TOOL_NAME
]);

/** Whether a call of `toolName` opens a revision in the preview. */
export function isOpenToolName(toolName: string | undefined): boolean {
  return toolName !== undefined && OPEN_TOOL_NAMES.has(toolName);
}

/**
 * What a call of the former `page.save` did to the App the conversation was about: the App's
 * draft revision it wrote, or why it wrote none. An open writes no App.
 */
type PageSaveApp =
  | { title: string; saved: true; revision: number }
  | { title: string; saved: false; message: string };

/** How one open stands. */
export type PageSave =
  | { state: "building"; name: string | undefined }
  | {
      state: "built";
      name: string | undefined;
      pageId: string;
      fileSetId: string;
      number: number;
      /** The name the folder gives itself: its manifest's, or its HTML's title. */
      title?: string;
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
 * Reads one open. `result` is absent while the call runs. An answer that is neither a revision
 * nor a list of findings is a call that failed. The name is the path an open names, or the name
 * a call of the former `page.save` gave.
 */
export function readPageSave(input: {
  args: unknown;
  result: unknown;
  failed?: boolean;
}): PageSave {
  const named = isRecord(input.args) ? (input.args.path ?? input.args.name) : undefined;
  const name = typeof named === "string" && named.trim() !== "" ? named.trim() : undefined;
  if (input.failed) {
    return { state: "failed", name };
  }
  if (input.result === undefined) {
    return { state: "building", name };
  }
  const container = isRecord(input.result) ? input.result : {};
  const output = isRecord(container.output) ? container.output : container;
  const { pageId, fileSetId, number, title } = output;
  const openedName = typeof output.path === "string" ? output.path : name;
  if (
    typeof pageId === "string" &&
    typeof fileSetId === "string" &&
    typeof number === "number" &&
    Number.isInteger(number) &&
    number > 0
  ) {
    const app = readSaveApp(output.app);
    return {
      state: "built",
      name: openedName,
      pageId,
      fileSetId,
      number,
      ...(typeof title === "string" && title.trim() !== "" ? { title: title.trim() } : {}),
      ...(app ? { app } : {})
    };
  }
  const errors = readBuildErrors(output.errors);
  return errors ? { state: "errors", name, errors } : { state: "failed", name };
}

/**
 * The name a built open is read by, on its card, in the panel head and in Save as app: the one
 * the folder gives itself in its manifest or its HTML title, or else the name of the folder.
 */
export function builtPageName(
  save: Extract<PageSave, { state: "built" }>,
  t: TranslationContextValue["t"]
): string {
  return save.title ?? folderName(save.name) ?? t("pages.unnamed");
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
    title: builtPageName(save, t),
    ...(save.name === undefined ? {} : { path: save.name }),
    conversationId,
    pageId: save.pageId,
    fileSetId: save.fileSetId
  };
}

/** The last part of an opened path, without the extension of an HTML file. */
function folderName(path: string | undefined): string | undefined {
  const last = path
    ?.replace(/\/+$/u, "")
    .split("/")
    .at(-1)
    ?.replace(/\.html?$/iu, "");
  return last === undefined || last === "" ? undefined : last;
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

/** The surface an open takes while it builds. One per call. */
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

/** What a run's opens may change in the surface slot. */
type PageRunSurface = SurfaceOf<"page"> | SurfaceOf<"page_building">;

/**
 * What the opens of a run ask of the surface slot, in the order they were made.
 *
 * - An open that starts takes the slot with what it builds, so the surface opens at the agent's
 *   first open, unless the slot shows a revision of the same path, which stays until the new
 *   one replaces it.
 * - A built revision opens, except one a call of the former `page.save` also wrote into the
 *   draft of the App the conversation was about: the App's surface shows it.
 * - Findings go under the revision of the same path that is shown, or onto what it builds.
 *
 * `current` is the surface the slot holds. Each start and each answer counts once: `handled`
 * keeps the ones that did.
 */
export function pageSurfaceAfterRunCalls(input: {
  conversationId: string;
  parts: readonly RunToolCall[];
  handled: Set<string>;
  current: Surface | undefined;
  t: TranslationContextValue["t"];
}): PageRunSurface | undefined {
  let next: PageRunSurface | undefined;
  for (const part of input.parts) {
    const callId = part.toolCallId;
    if (
      part.type !== "tool_call" ||
      !isOpenToolName(part.toolName) ||
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
        shown?.kind === "page" && save.name !== undefined && shown.path === save.name;
      if (!samePageShown) {
        next = pageBuildingSurface(callId, save, input.t);
      }
      continue;
    }
    input.handled.add(callId);
    if (save.state === "built") {
      // A former save that wrote the App's draft is seen as the App. What it built, where that
      // was shown, gives way to the revision rather than stay on.
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
      shown.path === save.name
    ) {
      next = { ...shown, buildErrors: save.errors };
    }
  }
  return next;
}
