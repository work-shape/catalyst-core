import type { ConfigAssetPublication, ConfigAssetRevision } from "@work-shape/catalyst-api-client";

/**
 * One version of an App in its history: the publish, and the draft saves made after it that no
 * publish made live.
 */
interface AppHistoryVersion {
  publication: ConfigAssetPublication;
  /** The saves after this publish and before the next one, the newest first. */
  saves: ConfigAssetRevision[];
}

/** The history of an App as far as it was read: its versions, the newest first. */
export interface AppHistory {
  versions: AppHistoryVersion[];
  /** The saves before the first publish that it did not make live, once it was read. */
  before: ConfigAssetRevision[];
}

/**
 * Folds the saves read so far under the publish each came after. Both lists are the newest
 * first. A save a publish made live is that version's row, never also a draft save, and a
 * publish of an earlier save again is a version of its own. A save older than every
 * publication read is held back while more publications are to come: it belongs to one not
 * read yet. A publish not read yet cannot make a newer save live, so none is shown twice.
 */
export function appHistory(
  publications: readonly ConfigAssetPublication[],
  revisions: readonly ConfigAssetRevision[],
  publicationsComplete: boolean
): AppHistory {
  const versions = publications.map((publication) => ({
    publication,
    saves: [] as ConfigAssetRevision[]
  }));
  const before: ConfigAssetRevision[] = [];
  const published = new Set(publications.map(({ revision }) => revision));
  for (const revision of revisions) {
    if (published.has(revision.revision)) continue;
    const saved = Date.parse(revision.createdAt);
    const version = versions.find(
      ({ publication }) => Date.parse(publication.publishedAt) <= saved
    );
    if (version) version.saves.push(revision);
    else if (publicationsComplete) before.push(revision);
  }
  return { versions, before };
}

/** Whether a save was made by an agent for its person, not by the person themselves. */
export function savedByAgent(revision: ConfigAssetRevision): boolean {
  const { origin } = revision;
  return origin?.kind === "agent_run" || (origin?.kind === "page" && origin.byAgent === true);
}
