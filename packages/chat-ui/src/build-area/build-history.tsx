import { useEffect, useRef, useState } from "react";
import type { ConfigAssetRevision } from "@vivd-catalyst/api-client";
import {
  Badge,
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
import { apiErrorMessage } from "../workspace-utils";
import { refusalsOf, type BuildWriteOutcome } from "./build-refusals";

const OPERATION_LABELS: Record<ConfigAssetRevision["operation"], TranslationKey> = {
  create: "configRevisionCreate",
  update: "configRevisionUpdate",
  delete: "configRevisionDelete",
  revert: "configRevisionRevert"
};

/**
 * The history of one asset, beside its page: every revision with who made it and when, the
 * newest first, and the way to make an earlier one the content again. A restore is a new
 * revision, so nothing of the history is lost by it.
 */
export function BuildHistory({
  open,
  title,
  currentRevision,
  load,
  onRestore,
  onClose
}: {
  open: boolean;
  /** The asset's name, for the drawer's description. */
  title: string;
  /** The revision the page holds. It is the one that cannot be restored. */
  currentRevision: number;
  load(): Promise<ConfigAssetRevision[]>;
  /** Absent for a reader who may not change the asset. */
  onRestore?: (revision: number) => Promise<BuildWriteOutcome>;
  onClose(): void;
}) {
  const { locale, t } = useTranslation();
  const [revisions, setRevisions] = useState<ConfigAssetRevision[]>();
  const [error, setError] = useState<string>();
  const [asked, setAsked] = useState<number>();
  const [restoring, setRestoring] = useState(false);

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
    setError(undefined);
    loadRef.current().then(
      (loaded) => {
        if (current) {
          setRevisions([...loaded].sort((left, right) => right.revision - left.revision));
        }
      },
      (loadError: unknown) => {
        if (current) {
          setError(apiErrorMessage(loadError, undefined) ?? t("configRevisionLoadFailed"));
        }
      }
    );
    return () => {
      current = false;
    };
  }, [open]);

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
        {error ? <InlineError>{error}</InlineError> : null}
        {revisions === undefined ? (
          error ? null : (
            <SkeletonList rows={4} />
          )
        ) : revisions.length === 0 ? (
          <EmptyState layout="inline">{t("configNoRevisions")}</EmptyState>
        ) : (
          <List aria-label={t("build.history")}>
            {revisions.map((revision) => {
              const isCurrent = revision.revision === currentRevision;
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
                  actionsVisible
                  actions={
                    !isCurrent && onRestore && revision.config !== null ? (
                      <Button
                        variant="outline"
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
