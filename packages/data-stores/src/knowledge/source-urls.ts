import type { DocumentSourceBoundary, DocumentSourceWebBoundary } from "@work-shape/catalyst-core";
import type { KnowledgeBaseDefinition } from "./definition";

type SyncedSource = NonNullable<KnowledgeBaseDefinition["sources"]>[number];

// A web source (KB-WEB) names addresses where any other source names folder ids. The sync
// engine passes both kinds on in one boundary: for a web source its addresses stand in the
// place of folder ids, so an item's `parents` name the address it was found from, and the
// walk gets the addresses by their kind. Spec: data-stores-and-knowledge-bases.md, "Web pages
// as a synced source".

/** How many links below a prefix's own page a web source follows unless it says. */
const WEB_SOURCE_MAX_DEPTH_DEFAULT = 3;

/** The web boundary of a source that names addresses, or nothing for one of folders. */
export function webBoundaryOf(source: SyncedSource): DocumentSourceWebBoundary | undefined {
  if (source.folders !== undefined) return undefined;
  return {
    pages: source.pages ?? [],
    prefixes: source.prefixes ?? [],
    sitemaps: source.sitemaps ?? [],
    maxDepth: source.maxDepth ?? WEB_SOURCE_MAX_DEPTH_DEFAULT,
    ...(source.include ? { include: source.include } : {}),
    ...(source.exclude ? { exclude: source.exclude } : {})
  };
}

/** What stands for the source's folders: its folder ids, or a web source's addresses. */
export function sourceFolderIds(source: SyncedSource): readonly string[] {
  return (
    source.folders ?? [
      ...(source.pages ?? []),
      ...(source.prefixes ?? []),
      ...(source.sitemaps ?? [])
    ]
  );
}

/** The boundary a source's `list`, `changes` and `fetch` are called with. */
export function sourceBoundary(source: SyncedSource): DocumentSourceBoundary {
  const web = webBoundaryOf(source);
  return { folderIds: sourceFolderIds(source), ...(web ? { web } : {}) };
}
