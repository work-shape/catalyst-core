import { useEffect, useRef, useState } from "react";
import type { ConfigAssetRevision } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  InlineError,
  List,
  ListRow,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import type { AppRevisionPage } from "./app-data";

/**
 * The revisions of one App beside its draft: who saved each and when, the newest first and
 * page by page, with the two pointers marked. A holder of the publish right makes any of them
 * the published one; the screen asks before it does.
 */
export function RevisionsDrawer({
  open,
  name,
  draftRevision,
  publishedRevision,
  load,
  onPublish,
  onClose
}: {
  open: boolean;
  /** The App's name, for the drawer's description. */
  name: string;
  draftRevision: number;
  publishedRevision: number | undefined;
  /** One page of the history, the newest first. `cursor` continues after an earlier page. */
  load(cursor: string | undefined): Promise<AppRevisionPage>;
  /** Absent for a reader who may not publish. */
  onPublish?: (revision: ConfigAssetRevision) => void;
  onClose(): void;
}) {
  const [revisions, setRevisions] = useState<ConfigAssetRevision[]>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  // Counts the reader's asks to read the history again after a read that failed.
  const [attempt, setAttempt] = useState(0);

  // `load` is a new function with every render of the screen; the opening is what reads.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  // Read with every opening, and again when a pointer moved: a publish changes the marks.
  useEffect(() => {
    if (!open) {
      return;
    }
    let current = true;
    setRevisions(undefined);
    setNextCursor(undefined);
    setFailed(false);
    loadRef.current(undefined).then(
      (page) => {
        if (current) {
          setRevisions(page.items);
          setNextCursor(page.nextCursor);
        }
      },
      () => {
        if (current) {
          setFailed(true);
        }
      }
    );
    return () => {
      current = false;
    };
  }, [open, attempt, draftRevision, publishedRevision]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await loadRef.current(nextCursor);
      setRevisions((known) => [...(known ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
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
      revisions={revisions}
      failed={failed}
      hasMore={nextCursor !== undefined}
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

/** The drawer for a given part of the history. */
export function RevisionsDrawerView({
  open,
  name,
  revisions,
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
  /** The revisions read so far. Absent until the first page arrived. */
  revisions: readonly ConfigAssetRevision[] | undefined;
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
            {revisions === undefined ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                {t("tryAgain")}
              </Button>
            ) : null}
          </InlineError>
        ) : null}
        {revisions === undefined ? (
          failed ? null : (
            <SkeletonList rows={4} />
          )
        ) : revisions.length === 0 ? (
          <EmptyState layout="inline">{t("apps.revisionsEmpty")}</EmptyState>
        ) : (
          // The rows bring their own inset: pulled out by it, their text shares the title's edge.
          <List aria-label={t("apps.revisions")} className="-mx-2">
            {revisions.map((revision) => {
              const isPublished = revision.revision === publishedRevision;
              return (
                <ListRow
                  key={revision.revision}
                  data-revision={revision.revision}
                  title={t("apps.revision", { number: revision.revision })}
                  chips={
                    <>
                      {isPublished ? (
                        <Badge tone="success" size="sm">
                          {t("apps.publishedBadge")}
                        </Badge>
                      ) : null}
                      {revision.revision === draftRevision ? (
                        <Badge size="sm">{t("apps.draft")}</Badge>
                      ) : null}
                    </>
                  }
                  description={[
                    ...(revision.actor ? [revision.actor.displayLabel] : []),
                    formatDateTime(revision.createdAt, locale)
                  ].join(" · ")}
                  descriptionWraps
                  actionsVisible
                  actions={
                    // A revision that holds nothing, as a delete leaves it, cannot be served.
                    onPublish && !isPublished && revision.config !== null ? (
                      <Button variant="ghost" size="sm" onClick={() => onPublish(revision)}>
                        {t("apps.publishThisRevision")}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </List>
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
