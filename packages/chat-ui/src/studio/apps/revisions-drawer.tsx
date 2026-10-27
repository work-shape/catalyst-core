import { useEffect, useRef, useState } from "react";
import type { ConfigAssetPublication, ConfigAssetRevision } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Drawer,
  EmptyState,
  InlineError,
  List,
  ListRow,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { formatMomentShort } from "../../shared/locale-format";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { AppPublicationPage, AppRevisionPage } from "./app-data";
import { appHistory, savedByAgent } from "./app-history";
import { personName } from "../../shared/person-name";

/**
 * The history of one App beside its draft: one row per version, the newest first, with the
 * draft saves made after it folded under it, page by page. A holder of the publish right makes
 * any save the published one; the screen asks before it does.
 */
export function RevisionsDrawer({
  open,
  name,
  draftRevision,
  publishedRevision,
  load,
  loadPublications,
  onPublish,
  onClose
}: {
  open: boolean;
  /** The App's name, for the drawer's description. */
  name: string;
  draftRevision: number;
  publishedRevision: number | undefined;
  /** One page of the saves, the newest first. `cursor` continues after an earlier page. */
  load(cursor: string | undefined): Promise<AppRevisionPage>;
  /** One page of the versions, the newest first. */
  loadPublications(cursor: string | undefined): Promise<AppPublicationPage>;
  /** Absent for a reader who may not publish. */
  onPublish?: (revision: ConfigAssetRevision) => void;
  onClose(): void;
}) {
  const [read, setRead] = useState<HistoryRead>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  // Counts the reader's asks to read the history again after a read that failed.
  const [attempt, setAttempt] = useState(0);

  // The loaders are new functions with every render of the screen; the opening is what reads.
  const loadRef = useRef({ load, loadPublications });
  useEffect(() => {
    loadRef.current = { load, loadPublications };
  }, [load, loadPublications]);
  // Read with every opening, and again when a pointer moved: a publish adds a version.
  useEffect(() => {
    if (!open) {
      return;
    }
    let current = true;
    setRead(undefined);
    setFailed(false);
    readHistory(loadRef.current, undefined).then(
      (next) => {
        if (current) setRead(next);
      },
      () => {
        if (current) setFailed(true);
      }
    );
    return () => {
      current = false;
    };
  }, [open, attempt, draftRevision, publishedRevision]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      setRead(await readHistory(loadRef.current, read));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <RevisionsDrawerView
      open={open}
      name={name}
      publications={read?.publications}
      revisions={read?.revisions}
      publicationsComplete={read !== undefined && read.publicationsCursor === undefined}
      failed={failed}
      hasMore={read?.revisionsCursor !== undefined}
      loadingMore={loadingMore}
      draftRevision={draftRevision}
      publishedRevision={publishedRevision}
      onPublish={onPublish}
      onLoadMore={() => {
        loadMore().catch(() => undefined);
      }}
      onRetry={() => setAttempt((count) => count + 1)}
      onClose={onClose}
    />
  );
}

/** What the drawer read so far of both lists, and where each continues. */
interface HistoryRead {
  publications: ConfigAssetPublication[];
  publicationsCursor: string | undefined;
  revisions: ConfigAssetRevision[];
  revisionsCursor: string | undefined;
}

/**
 * The next page of saves after `known`, and as many pages of versions as it takes to place
 * them: a save older than the oldest version read belongs to one further back.
 */
async function readHistory(
  loaders: {
    load(cursor: string | undefined): Promise<AppRevisionPage>;
    loadPublications(cursor: string | undefined): Promise<AppPublicationPage>;
  },
  known: HistoryRead | undefined
): Promise<HistoryRead> {
  const [saves, first] = await Promise.all([
    loaders.load(known?.revisionsCursor),
    known ? undefined : loaders.loadPublications(undefined)
  ]);
  const read: HistoryRead = {
    publications: known?.publications ?? first?.items ?? [],
    publicationsCursor: known ? known.publicationsCursor : first?.nextCursor,
    revisions: [...(known?.revisions ?? []), ...saves.items],
    revisionsCursor: saves.nextCursor
  };
  const oldestSave = read.revisions.at(-1)?.createdAt;
  while (read.publicationsCursor !== undefined && oldestSave !== undefined) {
    const oldestVersion = read.publications.at(-1)?.publishedAt;
    if (oldestVersion !== undefined && Date.parse(oldestVersion) <= Date.parse(oldestSave)) break;
    const page = await loaders.loadPublications(read.publicationsCursor);
    read.publications = [...read.publications, ...page.items];
    read.publicationsCursor = page.nextCursor;
  }
  return read;
}

/** The drawer for a given part of the history. */
export function RevisionsDrawerView({
  open,
  name,
  publications,
  revisions,
  publicationsComplete = true,
  failed,
  hasMore,
  loadingMore,
  draftRevision,
  publishedRevision,
  onPublish,
  onLoadMore,
  onRetry,
  onClose
}: {
  open: boolean;
  name: string;
  /** The versions read so far, the newest first. Absent until the first page arrived. */
  publications: readonly ConfigAssetPublication[] | undefined;
  /** The saves read so far, the newest first. Absent until the first page arrived. */
  revisions: readonly ConfigAssetRevision[] | undefined;
  /** Every version is read, so a save older than all of them came before the first. */
  publicationsComplete?: boolean;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  draftRevision: number;
  publishedRevision: number | undefined;
  onPublish?: (revision: ConfigAssetRevision) => void;
  onLoadMore(): void;
  onRetry(): void;
  onClose(): void;
}) {
  const { locale, t } = useTranslation();
  const history =
    publications && revisions
      ? appHistory(publications, revisions, publicationsComplete)
      : undefined;
  // The newest version is the live one while something is published.
  const liveNumber = publishedRevision === undefined ? undefined : publications?.[0]?.number;
  // A draft gone back to an earlier version is marked on the newest version of it.
  const draftNumber =
    draftRevision === publishedRevision
      ? undefined
      : publications?.find(({ revision }) => revision === draftRevision)?.number;
  // A version's save is its row, not a draft save: publishing it again goes from there.
  const publishable = (revision: ConfigAssetRevision | undefined) =>
    // A revision that holds nothing, as a delete leaves it, cannot be served.
    onPublish !== undefined &&
    revision !== undefined &&
    revision.revision !== publishedRevision &&
    revision.config !== null
      ? revision
      : undefined;
  const saveRows = (saves: readonly ConfigAssetRevision[]) => (
    <List className="-mx-2">
      {saves.map((revision) => (
        <ListRow
          key={revision.revision}
          data-revision={revision.revision}
          title={saveAuthor(revision, t)}
          chips={
            revision.revision === draftRevision ? <Badge size="sm">{t("apps.draft")}</Badge> : null
          }
          description={[
            ...(revision.origin?.kind === "page" && !savedByAgent(revision) && revision.actor
              ? [personName(revision.actor.displayLabel, t)]
              : []),
            formatMomentShort(revision.createdAt, locale)
          ].join(" · ")}
          descriptionWraps
          actionsVisible
          actions={
            publishable(revision) ? (
              <Button variant="ghost" size="sm" onClick={() => onPublish?.(revision)}>
                {t("apps.publishThisRevision")}
              </Button>
            ) : undefined
          }
        />
      ))}
    </List>
  );
  const folded = (label: string, saves: readonly ConfigAssetRevision[]) =>
    saves.length === 0 ? null : (
      <Disclosure className="px-2">
        <DisclosureTrigger>{label}</DisclosureTrigger>
        {/* Kept in the page while folded, so a long history keeps its rows in one place. */}
        <DisclosureContent keepMounted>{saveRows(saves)}</DisclosureContent>
      </Disclosure>
    );
  return (
    <Drawer
      open={open}
      title={t("apps.revisions")}
      description={t("apps.revisionsDescription", { name })}
      onClose={onClose}
    >
      <div className="grid gap-3">
        {failed ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("apps.revisionsFailed")}</span>
            {history === undefined ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                {t("tryAgain")}
              </Button>
            ) : null}
          </InlineError>
        ) : null}
        {history === undefined ? (
          failed ? null : (
            <SkeletonList rows={4} />
          )
        ) : history.versions.length === 0 && history.before.length === 0 ? (
          <EmptyState layout="inline">{t("apps.revisionsEmpty")}</EmptyState>
        ) : history.versions.length === 0 ? (
          // Nothing was published: the saves are the whole history, and nothing to fold under.
          saveRows(history.before)
        ) : (
          // The rows bring their own inset: pulled out by it, their text shares the title's edge.
          <ol aria-label={t("apps.revisions")} className="-mx-2 grid gap-1">
            {history.versions.map(({ publication, saves }) => {
              const again = publishable(
                revisions?.find(({ revision }) => revision === publication.revision)
              );
              return (
                <li key={publication.number} data-version={publication.number} className="grid">
                  <List>
                    <ListRow
                      title={t("apps.version", { number: publication.number })}
                      chips={
                        publication.number === liveNumber ? (
                          <Badge tone="success" size="sm">
                            {t("apps.publishedBadge")}
                          </Badge>
                        ) : publication.number === draftNumber ? (
                          <Badge size="sm">{t("apps.draft")}</Badge>
                        ) : null
                      }
                      description={[
                        publication.actor
                          ? t("apps.versionPublishedBy", {
                              name: personName(publication.actor.displayLabel, t),
                              date: formatMomentShort(publication.publishedAt, locale)
                            })
                          : t("apps.versionPublished", {
                              date: formatMomentShort(publication.publishedAt, locale)
                            }),
                        ...(publication.note ? [publication.note] : [])
                      ].join(" · ")}
                      descriptionWraps
                      actionsVisible
                      actions={
                        again ? (
                          <Button variant="ghost" size="sm" onClick={() => onPublish?.(again)}>
                            {t("apps.publishThisVersion")}
                          </Button>
                        ) : undefined
                      }
                    />
                  </List>
                  {folded(
                    saves.length === 1
                      ? t("apps.savesOne")
                      : t("apps.saves", { count: saves.length }),
                    saves
                  )}
                </li>
              );
            })}
            {history.before.length > 0 ? (
              <li className="grid">
                {folded(
                  history.before.length === 1
                    ? t("apps.savesBeforeFirstOne")
                    : t("apps.savesBeforeFirst", { count: history.before.length }),
                  history.before
                )}
              </li>
            ) : null}
          </ol>
        )}
        {hasMore ? (
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            loading={loadingMore}
            onClick={onLoadMore}
          >
            {t("apps.showMore")}
          </Button>
        ) : null}
      </div>
    </Drawer>
  );
}

/** Who made a save: the person, their agent for them, or the preview it was saved from. */
function saveAuthor(revision: ConfigAssetRevision, t: TranslationContextValue["t"]): string {
  const person = personName(revision.actor?.displayLabel, t);
  if (savedByAgent(revision)) return t("apps.saveByAgent", { name: person });
  if (revision.origin?.kind === "page") return t("apps.saveFromPreview");
  return person;
}
