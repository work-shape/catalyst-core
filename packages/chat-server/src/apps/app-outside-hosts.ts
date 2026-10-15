import { declaredExternalHostsOf } from "@work-shape/catalyst-app-build";
import type { ClientInstanceId, FileSet, FileSetId, PagesStore } from "@work-shape/catalyst-core";
import type { AppContentMode } from "../pages/app-content";

// Which outside hosts the frame of an App may connect to.
//
// A host is reviewed when a revision is published: the publish dialog names every host the
// revision lists. The published view therefore connects to the hosts its manifest lists. A
// draft is not reviewed, and it runs with the data its writer can read. A host that an agent
// adds to a draft's manifest would receive that data before anyone looked at the host, so a
// draft connects only to the hosts the published revision lists as well. The others are held
// back until the draft is published. A draft of an App with nothing published connects to none.

/** The hosts a frame may connect to, and those its manifest lists that it may not yet. */
export interface AppOutsideHosts {
  allowed: string[];
  heldBack: string[];
}

/**
 * The outside hosts of the revision a frame shows. `shown` is the file set of that revision and
 * `publishedFileSetId` the file set of the App's published revision, if it has one. The file
 * set of the published revision is read only for a draft that is another file set.
 */
export async function appOutsideHosts(
  pages: Pick<PagesStore, "getAssetFileSet">,
  input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    view: AppContentMode;
    shown: Pick<FileSet, "id" | "manifest">;
    publishedFileSetId: FileSetId | undefined;
  }
): Promise<AppOutsideHosts> {
  const declared = declaredExternalHostsOf(input.shown.manifest);
  if (input.view === "published" || input.publishedFileSetId === input.shown.id) {
    return { allowed: declared, heldBack: [] };
  }
  const published =
    input.publishedFileSetId === undefined
      ? undefined
      : await pages.getAssetFileSet({
          clientInstanceId: input.clientInstanceId,
          assetId: input.assetId,
          fileSetId: input.publishedFileSetId
        });
  const reviewed = new Set(published ? declaredExternalHostsOf(published.manifest) : []);
  return {
    allowed: declared.filter((host) => reviewed.has(host)),
    heldBack: declared.filter((host) => !reviewed.has(host))
  };
}
