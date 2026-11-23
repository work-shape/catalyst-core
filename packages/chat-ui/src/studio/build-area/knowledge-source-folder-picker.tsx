import { ChevronRight, Folder, FolderMinus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  Breadcrumb,
  Button,
  Checkbox,
  type CheckboxState,
  Dialog,
  EmptyState,
  FormNotice,
  IconButton,
  LoadMore
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { KnowledgeBaseSource } from "./knowledge-base-source";
import {
  canToggle,
  excludedFolders,
  excludeToStore,
  folderPathSegments,
  folderState,
  selectionSummary,
  toggleFolder,
  withExcludedFolders,
  withFolderNames,
  withFolderPath,
  withFolderUnread,
  type FolderSelection,
  type FolderState,
  type PlacedFolder
} from "./knowledge-source-folder-selection";

// The folders of a source, chosen by name (KB-FOLDERS-1): the reader walks the folders the
// Connection's account sees, from the top down, and ticks the ones whose documents the
// Knowledge Base reads. Every folder below a ticked one is read too, a folder added there later
// included, unless the reader unticks it: that folder is then left out by a pattern of the
// source's `exclude`. A folder's box says which it is: read whole, read in part, or not read.
// What the dialog answers is the folders' ids, the boundary the definition keeps, and `exclude`.

type Translate = TranslationContextValue["t"];

/** How many names a list in a sentence holds before it says how many more there are. */
const NAMES_SHOWN = 3;

/** One step of the way down: the top has no id. */
interface Place {
  id: string | undefined;
  name: string;
}

/** Names in one line, the first few by name. */
function namesLine(t: Translate, names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN
    ? t("knowledgeSources.pickMore", { names: shown, count: names.length - NAMES_SHOWN })
    : shown;
}

/** What a selection reads as, in one sentence. Empty while nothing is chosen. */
function folderSelectionLine(t: Translate, selection: FolderSelection): string {
  const { folders, excluded } = selectionSummary(selection);
  if (folders.length === 0) return "";
  const read = t(
    folders.length === 1 ? "knowledgeSources.pickSummary" : "knowledgeSources.pickSummaryEach",
    { folders: namesLine(t, folders) }
  );
  return excluded.length === 0
    ? read
    : t("knowledgeSources.pickSummaryWithout", { read, excluded: namesLine(t, excluded) });
}

/** How many folders a selection names, and how many it leaves out. */
function countLine(t: Translate, selection: FolderSelection): string {
  const chosen = selection.chosen.size;
  const count = t(chosen === 1 ? "knowledgeSources.pickCountOne" : "knowledgeSources.pickCount", {
    count: chosen
  });
  return selection.excluded.length === 0
    ? count
    : `${count} · ${t("knowledgeSources.pickCountLeftOut", { count: selection.excluded.length })}`;
}

const boxOf = (state: FolderState): CheckboxState =>
  state.state === "in"
    ? state.without.length > 0
      ? "indeterminate"
      : true
    : state.state === "none" && state.below > 0
      ? "indeterminate"
      : false;

/** The line under a folder that says how it stands, where its box alone does not. */
function stateLine(t: Translate, state: FolderState): string | undefined {
  switch (state.state) {
    case "in":
      return state.without.length > 0
        ? t("knowledgeSources.pickRowWithout", { excluded: namesLine(t, state.without) })
        : undefined;
    case "out":
      return t("knowledgeSources.pickRowOut");
    case "outAbove":
      return t("knowledgeSources.pickRowOutWith", { name: state.with });
    case "none":
      return state.below === 0
        ? undefined
        : t(
            state.below === 1
              ? "knowledgeSources.pickRowBelowOne"
              : "knowledgeSources.pickRowBelow",
            { count: state.below }
          );
  }
}

/** Reads where a chosen folder lies and what is directly in it, which the selection needs. */
function ChosenFolderRead({
  source,
  connection,
  folder,
  onRead,
  onUnread
}: {
  source: Pick<KnowledgeBaseSource, "useSourceFolders">;
  connection: string;
  folder: string;
  onRead(folder: string, path: string, names: readonly string[], complete: boolean): void;
  onUnread(folder: string): void;
}) {
  const read = source.useSourceFolders?.(connection, folder, true);
  const listing = read?.status === "ready" ? read.data : undefined;
  const path = listing?.folder.path;
  const folders = listing?.folders;
  const complete = listing !== undefined && listing.more === undefined;
  useEffect(() => {
    if (path !== undefined && folders !== undefined) {
      onRead(
        folder,
        path,
        folders.map((entry) => entry.name),
        complete
      );
    }
  }, [folder, path, folders, complete, onRead]);
  const unread = read === undefined || read.status === "failed" || read.status === "refused";
  useEffect(() => {
    if (unread) onUnread(folder);
  }, [folder, unread, onUnread]);
  return null;
}

export function KnowledgeSourceFolderPicker({
  source,
  connection,
  connectionTitle,
  chosen: initial,
  exclude = "",
  onClose,
  onChoose
}: {
  source: Pick<KnowledgeBaseSource, "useSourceFolders">;
  connection: string;
  /** The Connection as people read it: the name of the top. */
  connectionTitle: string;
  /** The folder ids the source reads already. */
  chosen: readonly string[];
  /** The source's `exclude` as its form holds it, one pattern per line. */
  exclude?: string;
  onClose(): void;
  /** The ids of the folders ticked, and `exclude` with the folders left out below them. */
  onChoose(folders: string[], exclude: string): void;
}) {
  const { t } = useTranslation();
  const [trail, setTrail] = useState<Place[]>([{ id: undefined, name: connectionTitle }]);
  const [selection, setSelection] = useState<FolderSelection>(() => ({
    chosen: new Map(initial.map((id) => [id, undefined])),
    excluded: excludedFolders(exclude)
  }));
  const [place] = useState(
    () => (folder: string, path: string, names: readonly string[], complete: boolean) =>
      setSelection((current) =>
        withFolderNames(
          withFolderPath(current, folder, folderPathSegments(path)),
          folder,
          names,
          complete
        )
      )
  );
  const [markUnread] = useState(
    () => (folder: string) => setSelection((current) => withFolderUnread(current, folder))
  );
  const rowsId = useId();
  const here = trail[trail.length - 1] ?? { id: undefined, name: connectionTitle };
  const read = source.useSourceFolders?.(connection, here.id, true);
  const listing = read?.status === "ready" ? read.data : undefined;
  const herePath = listing ? folderPathSegments(listing.folder.path) : [];
  const toggle = (folder: PlacedFolder, on: boolean) =>
    setSelection((current) => toggleFolder(current, folder, on));
  const hereFolder: PlacedFolder | undefined =
    here.id !== undefined && listing ? { id: listing.folder.id, path: herePath } : undefined;
  const hereState = hereFolder && folderState(selection, hereFolder);
  const summary = folderSelectionLine(t, selection);

  return (
    <Dialog
      open
      size="md"
      title={t("knowledgeSources.pickTitle")}
      description={t("knowledgeSources.pickDescription")}
      onClose={onClose}
      footer={
        <>
          <span
            className="mr-auto text-caption text-muted-foreground"
            aria-live="polite"
            data-knowledge-folders-count=""
          >
            {countLine(t, selection)}
          </span>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            data-knowledge-folders-apply=""
            disabled={selection.chosen.size === 0}
            onClick={() =>
              onChoose([...selection.chosen.keys()], excludeToStore(exclude, selection))
            }
          >
            {t("knowledgeSources.pickApply")}
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-3" data-knowledge-folder-picker="">
        {[...selection.chosen.keys()].map((folder) => (
          <ChosenFolderRead
            key={folder}
            source={source}
            connection={connection}
            folder={folder}
            onRead={place}
            onUnread={markUnread}
          />
        ))}
        <Breadcrumb
          label={t("knowledgeSources.pickTrail")}
          items={trail.map((place, index) => ({
            id: place.id ?? "",
            label: place.name,
            onSelect: () => setTrail(trail.slice(0, index + 1))
          }))}
        />
        {hereFolder && hereState ? (
          <Checkbox
            data-knowledge-folder-here=""
            label={t("knowledgeSources.pickHere", { name: here.name })}
            description={stateLine(t, hereState)}
            checked={boxOf(hereState)}
            disabled={!canToggle(selection, hereFolder)}
            onCheckedChange={(on) => toggle(hereFolder, on)}
          />
        ) : null}
        {read === undefined || read.status === "failed" || read.status === "refused" ? (
          <FormNotice tone="error">{t("knowledgeSources.pickFailed")}</FormNotice>
        ) : read.status === "loading" ? (
          <p className="text-caption text-muted-foreground">{t("knowledgeSources.pickLoading")}</p>
        ) : read.data.folders.length === 0 ? (
          <EmptyState layout="inline">{t("knowledgeSources.pickEmpty")}</EmptyState>
        ) : (
          <ul
            aria-label={t("knowledgeSources.pickList", { name: here.name })}
            className="grid max-h-80 min-w-0 overflow-y-auto rounded-md border"
          >
            {read.data.folders.map((folder, index) => {
              const placed = { id: folder.id, path: [...herePath, folder.name] };
              const state = folderState(selection, placed);
              const box = boxOf(state);
              const line = stateLine(t, state);
              const lineId = `${rowsId}-${index}`;
              return (
                <li
                  key={folder.id}
                  className="flex min-h-11 min-w-0 items-center gap-2 border-b px-3 last:border-b-0"
                  data-knowledge-folder={folder.id}
                  data-knowledge-folder-state={
                    box === "indeterminate" ? "some" : box ? "all" : "none"
                  }
                >
                  <Checkbox
                    aria-label={t("knowledgeSources.pickChoose", { name: folder.name })}
                    aria-describedby={line === undefined ? undefined : lineId}
                    checked={box}
                    disabled={!canToggle(selection, placed)}
                    onCheckedChange={(on) => toggle(placed, on)}
                  />
                  <button
                    type="button"
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-body hover:text-foreground focus-visible:focus-ring"
                    aria-label={t("knowledgeSources.pickOpen", { name: folder.name })}
                    data-knowledge-folder-open=""
                    onClick={() => setTrail([...trail, { id: folder.id, name: folder.name }])}
                  >
                    <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span
                      className={
                        state.state === "out" || state.state === "outAbove"
                          ? "min-w-0 truncate text-muted-foreground"
                          : "min-w-0 truncate"
                      }
                    >
                      {folder.name}
                    </span>
                    <span
                      id={line === undefined ? undefined : lineId}
                      className="min-w-0 flex-1 truncate text-right text-caption text-muted-foreground"
                    >
                      {line}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {listing?.more ? (
          <LoadMore loading={listing.more.loading} onLoad={listing.more.load} />
        ) : null}
        <p
          className="rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground"
          aria-live="polite"
          data-knowledge-folders-summary=""
        >
          {summary === "" ? t("knowledgeSources.noFolderChosen") : summary}
        </p>
      </div>
    </Dialog>
  );
}

/**
 * The folders a source leaves out below its chosen ones, as its card lists them: each by its
 * path, with a button that has it read again.
 */
export function KnowledgeSourceExcludedFolders({
  exclude,
  canWrite,
  onChange
}: {
  /** The source's `exclude` as its form holds it. */
  exclude: string;
  canWrite: boolean;
  onChange(exclude: string): void;
}) {
  const { t } = useTranslation();
  const folders = excludedFolders(exclude);
  if (folders.length === 0) return null;
  return (
    <ul className="grid min-w-0 gap-1" data-knowledge-source-excluded="">
      {folders.map((folder) => (
        <li key={folder} className="flex min-w-0 items-center gap-2">
          <FolderMinus aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-body text-muted-foreground"
            data-knowledge-source-excluded-folder={folder}
          >
            {t("knowledgeSources.without", { folders: folder })}
          </span>
          {canWrite ? (
            <IconButton
              variant="ghost"
              size="sm"
              label={t("knowledgeSources.readAgain", { name: folder })}
              onClick={() =>
                onChange(
                  withExcludedFolders(
                    exclude,
                    folders.filter((other) => other !== folder)
                  )
                )
              }
            >
              <X aria-hidden="true" />
            </IconButton>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** What a source leaves out below its folders, as the card's title names it after them. */
export function KnowledgeSourceExcludedSuffix({ exclude }: { exclude: string }) {
  const { t } = useTranslation();
  const folders = excludedFolders(exclude);
  return folders.length === 0 ? null : (
    <>, {t("knowledgeSources.without", { folders: namesLine(t, folders) })}</>
  );
}
