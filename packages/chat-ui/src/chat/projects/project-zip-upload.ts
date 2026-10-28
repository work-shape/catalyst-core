import type { ApiClient, LocaleCode } from "@work-shape/catalyst-api-client";
import { completedOutput } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import {
  checkProjectUploads,
  expandProjectUploads,
  formatProjectBytes,
  projectFileName,
  projectUploadCaps,
  runLimited,
  takenUploadPaths,
  zipFolderName,
  type ProjectUploadRefusal
} from "./project-files-model";

/** Files of an unpacked .zip go into the project this many at a time. */
const ZIP_UPLOADS_AT_ONCE = 2;

/** The plain sentence for a set of uploads the project does not take. */
export function projectUploadRefusalText(
  refused: ProjectUploadRefusal,
  t: TranslationContextValue["t"],
  locale: LocaleCode
): string {
  const max = (bytes: number) => formatProjectBytes(bytes, locale);
  switch (refused.limit) {
    case "files":
      return t("projectFiles.refusedFiles", { count: refused.count, max: refused.max });
    case "file_bytes":
      return t("projectFiles.refusedFileBytes", {
        name: projectFileName(refused.path),
        max: max(refused.max)
      });
    case "project_bytes":
      return t("projectFiles.refusedProjectBytes", {
        bytes: max(refused.bytes),
        max: max(refused.max)
      });
    case "unreadable":
      return t("projectFiles.refusedUnreadable", { name: projectFileName(refused.path) });
    case "unsafe_path":
      return t("projectFiles.refusedUnsafePath", { name: projectFileName(refused.path) });
  }
}

export type ProjectZipOutcome =
  | { status: "unpacked"; folder: string; files: number }
  | { status: "refused"; refusal: ProjectUploadRefusal }
  /** The person kept the files already in the project. */
  | { status: "cancelled" };

/**
 * A .zip handed to a project's chat: unpacked in the browser into a folder of the archive's
 * name in the project, the archive itself not kept. Real sizes are checked against the project's
 * caps while it is unpacked, before any file is sent. Files at a taken path become that file's
 * newest version once `confirmReplace` agrees.
 */
export async function unpackZipIntoProject(input: {
  client: ApiClient;
  projectId: string;
  zip: File;
  confirmReplace(paths: string[]): boolean;
  heldMessage: string;
}): Promise<ProjectZipOutcome> {
  const { client, projectId, zip } = input;
  const current = await client.projects.files.list({ params: { projectId } });
  const expanded = await expandProjectUploads(
    [
      {
        path: zip.name,
        size: zip.size,
        read: () => Promise.resolve(zip)
      }
    ],
    projectUploadCaps(current)
  );
  if (!expanded.ok) return { status: "refused", refusal: expanded.refusal };
  const refused = checkProjectUploads(expanded.uploads, {
    usage: current.usage,
    limits: current.limits,
    paths: new Set(current.items.map((file) => file.path))
  });
  if (refused) return { status: "refused", refusal: refused };
  const taken = takenUploadPaths(expanded.uploads, current.items);
  if (taken.size > 0 && !input.confirmReplace([...taken.keys()])) return { status: "cancelled" };
  await runLimited(expanded.uploads, ZIP_UPLOADS_AT_ONCE, async (upload) => {
    const replaces = taken.get(upload.path);
    completedOutput(
      await client.projects.files.upload({
        params: { projectId },
        query: { path: upload.path, ...(replaces === undefined ? {} : { replaces }) },
        file: await upload.read()
      }),
      input.heldMessage
    );
  });
  return { status: "unpacked", folder: zipFolderName(zip.name), files: expanded.uploads.length };
}
