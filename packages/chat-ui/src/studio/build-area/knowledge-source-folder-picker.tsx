import { ChevronRight, Folder } from "lucide-react";
import { useState } from "react";
import {
  Breadcrumb,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  FormNotice,
  LoadMore
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { KnowledgeBaseSource } from "./knowledge-base-source";

// The folders of a source, chosen by name (KB-FOLDERS-1): the reader walks the folders the
// Connection's account sees, from the top down, and ticks the ones whose documents the
// Knowledge Base reads. Every folder below a ticked one is read too. What the dialog answers is
// the folders' ids, the boundary the definition keeps.

/** One step of the way down: the top has no id. */
interface Place {
  id: string | undefined;
  name: string;
}

export function KnowledgeSourceFolderPicker({
  source,
  connection,
  connectionTitle,
  chosen: initial,
  onClose,
  onChoose
}: {
  source: KnowledgeBaseSource;
  connection: string;
  /** The Connection as people read it: the name of the top. */
  connectionTitle: string;
  /** The folder ids the source reads already. */
  chosen: readonly string[];
  onClose(): void;
  /** The ids of the folders ticked. */
  onChoose(folders: string[]): void;
}) {
  const { t } = useTranslation();
  const [trail, setTrail] = useState<Place[]>([{ id: undefined, name: connectionTitle }]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(initial));
  const here = trail[trail.length - 1] ?? { id: undefined, name: connectionTitle };
  const read = source.useSourceFolders?.(connection, here.id, true);
  const listing = read?.status === "ready" ? read.data : undefined;
  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog
      open
      size="md"
      title={t("knowledgeSources.pickTitle")}
      description={t("knowledgeSources.pickDescription")}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-caption text-muted-foreground" aria-live="polite">
            {t("knowledgeSources.pickCount", { count: chosen.size })}
          </span>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            data-knowledge-folders-apply=""
            disabled={chosen.size === 0}
            onClick={() => onChoose([...chosen])}
          >
            {t("knowledgeSources.pickApply")}
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-3" data-knowledge-folder-picker="">
        <Breadcrumb
          label={t("knowledgeSources.pickTrail")}
          items={trail.map((place, index) => ({
            id: place.id ?? "",
            label: place.name,
            onSelect: () => setTrail(trail.slice(0, index + 1))
          }))}
        />
        {here.id !== undefined && listing ? (
          <Checkbox
            data-knowledge-folder-here=""
            label={t("knowledgeSources.pickHere", { name: here.name })}
            checked={chosen.has(here.id)}
            onCheckedChange={(on) => toggle(listing.folder.id, on)}
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
            {read.data.folders.map((folder) => (
              <li
                key={folder.id}
                className="flex min-h-11 min-w-0 items-center gap-2 border-b px-3 last:border-b-0"
                data-knowledge-folder={folder.id}
              >
                <Checkbox
                  aria-label={t("knowledgeSources.pickChoose", { name: folder.name })}
                  checked={chosen.has(folder.id)}
                  onCheckedChange={(on) => toggle(folder.id, on)}
                />
                <button
                  type="button"
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-body hover:text-foreground focus-visible:focus-ring"
                  aria-label={t("knowledgeSources.pickOpen", { name: folder.name })}
                  data-knowledge-folder-open=""
                  onClick={() => setTrail([...trail, { id: folder.id, name: folder.name }])}
                >
                  <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing?.more ? (
          <LoadMore loading={listing.more.loading} onLoad={listing.more.load} />
        ) : null}
      </div>
    </Dialog>
  );
}
