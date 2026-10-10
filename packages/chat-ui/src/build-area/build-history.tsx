import { useEffect, useRef, useState } from "react";
import type { ConfigAssetRevision } from "@vivd-catalyst/api-client";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  InlineError,
  List,
  ListRow,
  SkeletonList
} from "@vivd-catalyst/ui";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../i18n";
import type { BuildRevisionPage } from "./build-data";
import { instanceSentence, refusalsOf, type BuildWriteOutcome } from "./build-refusals";

const OPERATION_LABELS: Record<ConfigAssetRevision["operation"], TranslationKey> = {
  create: "configRevisionCreate",
  update: "configRevisionUpdate",
  delete: "configRevisionDelete",
  revert: "configRevisionRevert"
};

/**
 * The history of one asset, beside its page: its revisions with who made each and when, the
 * newest first and page by page, and the way to make an earlier one the content again. A
 * restore is a new revision, so nothing of the history is lost by it.
 */
export function BuildHistory({
  open,
  title,
  heldRevision,
  load,
  onRestore,
  onClose
}: {
  open: boolean;
  /** The asset's name, for the drawer's description. */
  title: string;
  /**
   * The revision the page holds. While the instance has a newer one, nothing is restored from
   * here: the page loads the newer version first.
   */
  heldRevision: number;
  /** One page of the history, the newest first. `cursor` continues after an earlier page. */
  load(cursor: string | undefined): Promise<BuildRevisionPage>;
  /** Absent for a reader who may not change the asset. */
  onRestore?: (revision: number) => Promise<BuildWriteOutcome>;
  onClose(): void;
}) {
  const { locale, t } = useTranslation();
  const [revisions, setRevisions] = useState<ConfigAssetRevision[]>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [asked, setAsked] = useState<number>();
  const [restoring, setRestoring] = useState(false);
  // Counts the reader's asks to read the history again after a read that failed.
  const [attempt, setAttempt] = useState(0);

  // `load` is a new function with every render of the page; the opening is what reads.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  // Read with every opening: a save on the page adds a revision.
  useEffect(() => {
    if (!open) {
      return;
    }
    let current = true;
    setRevisions(undefined);
    setNextCursor(undefined);
    setError(undefined);
    loadRef.current(undefined).then(
      (page) => {
        if (current) {
          setRevisions(page.items);
          setNextCursor(page.nextCursor);
        }
      },
      (loadError: unknown) => {
        if (current) {
          setError(instanceSentence(loadError) ?? t("configRevisionLoadFailed"));
        }
      }
    );
    return () => {
      current = false;
    };
  }, [open, attempt]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await loadRef.current(nextCursor);
      setRevisions((known) => [...(known ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
      setError(undefined);
    } catch (loadError) {
      setError(instanceSentence(loadError) ?? t("configRevisionLoadFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  // The newest revision is the asset's content now, whatever the page holds.
  const newest = revisions?.[0]?.revision;
  const stale = newest !== undefined && newest !== heldRevision;

  const restore = async (revision: number) => {
    if (!onRestore) {
      return;
    }
    setRestoring(true);
    const outcome = await onRestore(revision);
    setRestoring(false);
    setAsked(undefined);
    const refusals = [
      ...refusalsOf(outcome, undefined),
      ...refusalsOf(outcome, "tools"),
      ...refusalsOf(outcome, "model"),
      ...refusalsOf(outcome, "skills")
    ];
    setError(refusals.length > 0 ? refusals.join(" ") : undefined);
  };

  return (
    <Drawer
      open={open}
      title={t("build.history")}
      description={t("build.historyDescription", { name: title })}
      onClose={onClose}
    >
      <div className="grid gap-3">
        {error ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            {revisions === undefined ? (
              <Button variant="outline" size="sm" onClick={() => setAttempt((count) => count + 1)}>
                {t("tryAgain")}
              </Button>
            ) : null}
          </InlineError>
        ) : null}
        {stale ? (
          <Banner tone="warning" data-history-stale="">
            {t("build.historyStale")}
          </Banner>
        ) : null}
        {revisions === undefined ? (
          error ? null : (
            <SkeletonList rows={4} />
          )
        ) : revisions.length === 0 ? (
          <EmptyState layout="inline">{t("configNoRevisions")}</EmptyState>
        ) : (
          // The rows bring their own inset: pulled out by it, their text shares the title's edge.
          <List aria-label={t("build.history")} className="-mx-2">
            {revisions.map((revision) => {
              const isCurrent = revision.revision === newest;
              return (
                <ListRow
                  key={revision.revision}
                  data-revision={revision.revision}
                  title={t("build.revisionNumber", { number: revision.revision })}
                  chips={
                    <>
                      <Badge appearance="outline">{t(OPERATION_LABELS[revision.operation])}</Badge>
                      {isCurrent ? <Badge>{t("configCurrent")}</Badge> : null}
                    </>
                  }
                  description={[
                    formatDateTime(revision.createdAt, locale),
                    ...(revision.actor ? [revision.actor.displayLabel] : [])
                  ].join(" · ")}
                  descriptionWraps
                  actionsVisible
                  actions={
                    !isCurrent && !stale && onRestore && revision.config !== null ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("build.restoreRevision", { number: revision.revision })}
                        onClick={() => setAsked(revision.revision)}
                      >
                        {t("configRestore")}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </List>
        )}
        {nextCursor === undefined ? null : (
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            loading={loadingMore}
            onClick={() => {
              loadMore().catch(() => undefined);
            }}
          >
            {t("build.showMore")}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={asked !== undefined}
        tone="primary"
        title={t("build.restoreTitle", { number: asked ?? 0 })}
        confirmLabel={t("configRestore")}
        loading={restoring}
        onConfirm={() => {
          if (asked !== undefined) {
            restore(asked).catch(() => undefined);
          }
        }}
        onClose={() => setAsked(undefined)}
      >
        {t("build.restoreDescription")}
      </ConfirmDialog>
    </Drawer>
  );
}
