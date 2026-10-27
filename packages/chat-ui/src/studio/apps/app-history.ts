import type { ConfigAssetPublication, ConfigAssetRevision } from "@work-shape/catalyst-api-client";

/** One version of an App in its history: the publish, and the draft saves made after it. */
interface AppHistoryVersion {
  publication: ConfigAssetPublication;
  /** The saves after this publish and before the next one, the newest first. */
  saves: ConfigAssetRevision[];
}

/** The history of an App as far as it was read: its versions, the newest first. */
export interface AppHistory {
  versions: AppHistoryVersion[];
  /** The saves before the first publish, once the first publish was read. */
  before: ConfigAssetRevision[];
}

/**
 * Folds the saves read so far under the publish each came after. Both lists are the newest
 * first. A save older than every publication read is held back while more publications are
 * to come: it belongs to one not read yet.
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
  for (const revision of revisions) {
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
