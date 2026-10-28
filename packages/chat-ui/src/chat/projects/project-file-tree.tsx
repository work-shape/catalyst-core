import { FileImage, FileText } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectFileView } from "@work-shape/catalyst-api-client";
import { FileTree } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { formatProjectBytes, projectFilePreviewKind } from "./project-files-model";

/** A project's files in their folders, each with its size; the same tree on every surface. */
export function ProjectFileTree({
  files,
  selectedPath,
  onOpen,
  fileActions,
  folderActions
}: {
  files: readonly ProjectFileView[];
  selectedPath?: string;
  onOpen(file: ProjectFileView): void;
  fileActions?(file: ProjectFileView): ReactNode;
  folderActions?(path: string): ReactNode;
}) {
  const { t, locale } = useTranslation();
  const items = files.map((file) => {
    const kind = projectFilePreviewKind(file);
    return {
      path: file.path,
      file,
      icon:
        kind === "image" ? (
          <FileImage aria-hidden="true" className="size-4" />
        ) : kind === "text" ? (
          <FileText aria-hidden="true" className="size-4" />
        ) : undefined,
      meta: formatProjectBytes(file.byteSize, locale),
      actions: fileActions?.(file),
      selected: file.path === selectedPath
    };
  });
  return (
    <FileTree
      label={t("projectFiles.treeLabel")}
      items={items}
      fileTestId="project-file-row"
      onOpen={(item) => onOpen(item.file)}
      folderActions={folderActions}
    />
  );
}
