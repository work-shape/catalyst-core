import { useState } from "react";
import { EmptyState } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { changedSourcePaths, defaultOpenPath, PageFilesView } from "../pages/page-files";
import { useAppFiles } from "./app-data";
import { appRefusalText } from "./app-model";

/**
 * The source files of the draft, read-only, the way a Page shows its own. A file counts as
 * changed where the published revision does not hold it or holds it with other content. The
 * files arrive with their contents in one answer, so opening a file asks for nothing more.
 * Against what is live, each file is marked new, changed or removed, and a marked file opens
 * as its diff against the live text (DT-1b).
 */
export function AppDraftFiles({
  workspaceId,
  app,
  revision,
  publishedRevision
}: {
  workspaceId: string;
  app: string;
  /** The number of the draft. */
  revision: number;
  publishedRevision: number | undefined;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string>();
  const [listShown, setListShown] = useState(false);
  const draft = useAppFiles(workspaceId, app, revision);
  const comparedTo = publishedRevision === revision ? undefined : publishedRevision;
  const published = useAppFiles(workspaceId, app, comparedTo);

  if (draft.error !== undefined) {
    const refusal = appRefusalText(draft.error, t);
    if (refusal) {
      return (
        <EmptyState layout="inline" className="p-4">
          {refusal}
        </EmptyState>
      );
    }
  }
  if (draft.record?.filesOmitted) {
    return (
      <EmptyState layout="inline" className="p-4">
        {t("apps.filesTooLarge")}
      </EmptyState>
    );
  }
  const drafted = draft.record?.files;
  // What is published may be unreadable; the draft's files are shown without the comparison.
  const comparing = comparedTo !== undefined && published.loading;
  const live = comparedTo === undefined ? undefined : published.record?.files;
  const changed = changedSourcePaths(drafted ?? [], live);
  const marks = fileMarks(drafted ?? [], live, changed);
  // A file the draft removed stays in the list, after the draft's own, to show what goes.
  const removed = (live ?? []).filter((file) => marks.get(file.path) === "removed");
  const files = drafted === undefined ? undefined : [...drafted, ...removed];
  const open = chosen ?? (comparing || !files ? undefined : defaultOpenPath(files, changed));
  const file = drafted?.find((candidate) => candidate.path === open);
  const before = live?.find((candidate) => candidate.path === open);
  const mark = open === undefined ? undefined : marks.get(open);
  return (
    <PageFilesView
      files={draft.error !== undefined ? "failed" : comparing || !files ? "loading" : files}
      changed={changed}
      marks={marks}
      open={open}
      content={
        mark !== undefined && (file?.text !== undefined || before?.text !== undefined)
          ? { status: "diff", before: before?.text, after: file?.text }
          : file?.text === undefined
            ? { status: "not-text" }
            : { status: "ready", text: file.text }
      }
      listShown={listShown}
      onOpen={(path) => {
        setChosen(path);
        setListShown(false);
      }}
      onShowList={() => setListShown(true)}
    />
  );
}

/** Each file against what is live: new where live has no such path, removed where the draft has none. */
export function fileMarks(
  draft: readonly { path: string }[],
  live: readonly { path: string }[] | undefined,
  changed: ReadonlySet<string>
): Map<string, "new" | "changed" | "removed"> {
  const marks = new Map<string, "new" | "changed" | "removed">();
  if (live === undefined) return marks;
  const before = new Set(live.map((file) => file.path));
  const after = new Set(draft.map((file) => file.path));
  for (const path of changed) marks.set(path, before.has(path) ? "changed" : "new");
  for (const path of before) if (!after.has(path)) marks.set(path, "removed");
  return marks;
}
