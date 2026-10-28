import { isOpenToolName, readPageSave } from "../../studio/pages/page-save";
import { appSavedByCall } from "./subject-run";

// One card per App and per preview in a conversation (APPCARD-1). The agent saves an App and
// opens a folder in the preview again and again; each call used to leave a card of its own, so
// a conversation held several cards that looked the same. Only the newest call of each App and
// of each folder stays a card. An earlier one becomes a line in the run's work, and a folder that
// an `app.save` made into an App has the App's card stand for its previews.

/** What a call that is no longer a card says in the run's work. */
export type FoldedCard = "app_draft" | "preview";

/** One part of a message of the thread, as the thread hands it to its parts. */
export interface CardFoldPart {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

/** Nothing folds: the thread outside a conversation, and a conversation with one card each. */
export const NO_FOLDED_CARDS: ReadonlyMap<string, FoldedCard> = new Map();

/**
 * The folder a call names, as the agent passed it to `workspace.open` and again to `app.save`
 * ("as you passed it there"): a leading `./` and a closing `/` say the same folder.
 */
function folderOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("path" in args)) return undefined;
  const path = args.path;
  if (typeof path !== "string") return undefined;
  const folder = path
    .trim()
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/+$/u, "");
  return folder === "" ? undefined : folder;
}

/**
 * The calls of a whole conversation whose card folds, by call id, from its parts in the order
 * the thread shows them. Read it over every message of the thread: a completed run lives in its
 * projection, which the thread's messages already carry, so a save of an earlier run counts.
 * - `app.save`: only the newest save of each App is its card; every earlier one is "app_draft".
 * - `workspace.open`: only the newest built preview of each folder is its card; an earlier one
 *   is "preview". A folder that a save in this conversation made into an App shows the App's
 *   card, so each of its built previews is "preview". An open that builds, or that the build
 *   refused, keeps its own card: it says what is happening or what the build found.
 */
export function foldedCards(parts: readonly CardFoldPart[]): ReadonlyMap<string, FoldedCard> {
  const saves = new Map<string, string[]>();
  const savedFolders = new Set<string>();
  const previews: { callId: string; folder: string | undefined }[] = [];
  for (const part of parts) {
    if (part.type !== "tool-call" || part.toolName === undefined || !part.toolCallId) continue;
    const saved = appSavedByCall({
      toolName: part.toolName,
      result: part.result,
      ...(part.isError === undefined ? {} : { isError: part.isError })
    });
    if (saved) {
      // A call the thread shows twice, as it streams and from its projection, is one save.
      const callIds = saves.get(saved.name) ?? [];
      if (!callIds.includes(part.toolCallId)) saves.set(saved.name, [...callIds, part.toolCallId]);
      const folder = folderOf(part.args);
      if (folder !== undefined) savedFolders.add(folder);
      continue;
    }
    if (isOpenToolName(part.toolName)) {
      const opened = readPageSave({
        args: part.args,
        result: part.result,
        failed: part.isError === true
      });
      if (
        opened.state === "built" &&
        !previews.some((preview) => preview.callId === part.toolCallId)
      ) {
        previews.push({ callId: part.toolCallId, folder: folderOf({ path: opened.name }) });
      }
    }
  }
  const folded = new Map<string, FoldedCard>();
  for (const callIds of saves.values()) {
    for (const callId of callIds.slice(0, -1)) folded.set(callId, "app_draft");
  }
  const newestPreview = new Map<string, string>();
  for (const preview of previews) {
    if (preview.folder !== undefined) newestPreview.set(preview.folder, preview.callId);
  }
  for (const preview of previews) {
    if (preview.folder === undefined) continue;
    if (savedFolders.has(preview.folder) || newestPreview.get(preview.folder) !== preview.callId) {
      folded.set(preview.callId, "preview");
    }
  }
  return folded.size === 0 ? NO_FOLDED_CARDS : folded;
}
