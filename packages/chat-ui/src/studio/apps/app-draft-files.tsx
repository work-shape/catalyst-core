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
    const refusal = appRefusalText(draft.error);
    if (refusal) {
      return (
        <EmptyState layout="inline" className="p-4">
          {t(refusal)}
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
  const files = draft.record?.files;
  // What is published may be unreadable; the draft's files are shown without the comparison.
  const comparing = comparedTo !== undefined && published.loading;
  const changed = changedSourcePaths(files ?? [], published.record?.files);
  const open = chosen ?? (comparing || !files ? undefined : defaultOpenPath(files, changed));
  const file = files?.find((candidate) => candidate.path === open);
  return (
    <PageFilesView
      files={draft.error !== undefined ? "failed" : comparing || !files ? "loading" : files}
      changed={changed}
      open={open}
      content={
        file?.text === undefined ? { status: "not-text" } : { status: "ready", text: file.text }
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
