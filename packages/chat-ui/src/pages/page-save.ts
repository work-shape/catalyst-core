import type { TranslationContextValue } from "../i18n";
import type { PageBuildError, SurfaceOf } from "../surface/surface";

// What the thread knows of a Page: the calls of `page.save`. A call names the Page, and its
// answer is the revision it stored or the findings of the build that refused it.

export const PAGE_SAVE_TOOL_NAME = "page.save";

/** How one call of `page.save` stands. */
export type PageSave =
  | { state: "building"; name: string | undefined }
  | { state: "built"; name: string | undefined; pageId: string; fileSetId: string; number: number }
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
    return { state: "built", name, pageId, fileSetId, number };
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

/**
 * What the calls of `page.save` in a run ask of the surface slot, in the order they were made:
 * a stored revision opens, and findings go under the revision of the same Page that is shown.
 * `current` is the surface the slot holds. Each call is answered once: `handled` keeps the
 * calls that were.
 */
export function pageSurfaceAfterRunCalls(input: {
  conversationId: string;
  parts: readonly RunToolCall[];
  handled: Set<string>;
  current: SurfaceOf<"page"> | undefined;
  t: TranslationContextValue["t"];
}): SurfaceOf<"page"> | undefined {
  let next: SurfaceOf<"page"> | undefined;
  for (const part of input.parts) {
    if (
      part.type !== "tool_call" ||
      part.toolName !== PAGE_SAVE_TOOL_NAME ||
      part.toolCallId === undefined ||
      input.handled.has(part.toolCallId)
    ) {
      continue;
    }
    const save = readPageSave({
      args: part.input,
      result: part.state === "output_available" ? part.output : undefined,
      failed: part.state === "output_error"
    });
    if (save.state === "building") {
      continue;
    }
    input.handled.add(part.toolCallId);
    if (save.state === "built") {
      next = pageSurface(input.conversationId, save, input.t);
      continue;
    }
    const shown = next ?? input.current;
    if (save.state === "errors" && shown && save.name !== undefined && shown.title === save.name) {
      next = { ...shown, buildErrors: save.errors };
    }
  }
  return next;
}
