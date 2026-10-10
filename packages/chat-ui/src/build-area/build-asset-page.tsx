import { History, MoreHorizontal, SearchX, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormNotice,
  IconButton,
  InlineError,
  Page,
  PageHeader,
  SkeletonPage
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { usePageShown } from "./asset-editor-shell";
import type {
  BuildAsset,
  BuildAssetKind,
  BuildAssetStart,
  BuildPageSlot
} from "./build-asset-kind";
import type { BuildSource } from "./build-data";
import { BuildHistory } from "./build-history";
import type { VisibleBuildKind } from "./build-model";
import { readBuildRefusal, type BuildWriteOutcome } from "./build-refusals";

interface AssetPageProps {
  source: BuildSource;
  page: BuildPageSlot;
  back: ReactNode;
  onUnsavedChange(unsaved: boolean): void;
}

/** The page of a new asset. It has no address until it is saved. */
export function NewAssetPage({
  entry,
  start,
  onCreated,
  ...page
}: AssetPageProps & {
  entry: BuildAssetKind;
  start: BuildAssetStart;
  onCreated(name: string): void;
}) {
  const { t } = useTranslation();
  const { source } = page;
  const Editor = entry.Editor;
  return (
    <Editor
      page={page.page}
      back={page.back}
      actions={null}
      notice={null}
      asset={undefined}
      start={start}
      canWrite
      instanceWrite={source.rights.instanceWrite}
      onUnsavedChange={page.onUnsavedChange}
      save={async (config) => {
        try {
          await source.writes.put({
            kind: entry.kind,
            name: start.name,
            config,
            expectedRevision: undefined
          });
          onCreated(start.name);
          return { ok: true };
        } catch (error) {
          const outcome = readBuildRefusal(error, t);
          // A create that meets a conflict found the id taken.
          return !outcome.ok && outcome.conflict
            ? {
                ok: false,
                conflict: false,
                refusals: [{ message: t("build.nameTaken", { name: start.name }) }]
              }
            : outcome;
        }
      }}
    />
  );
}

/** The page at an asset's address: the asset once it is read, and every state before that. */
export function ExistingAssetPage({
  kind,
  name,
  onDeleted,
  ...page
}: AssetPageProps & {
  kind: VisibleBuildKind;
  name: string;
  onDeleted(): void;
}) {
  const { t } = useTranslation();
  const { entry } = kind;
  const read = page.source.useAsset(entry.kind, name);
  usePageShown(page.page, read.status);

  if (read.status === "ready") {
    return (
      // A newer read is another asset to the page: the form starts again from it.
      <LoadedAssetPage
        key={read.loadedAt}
        {...page}
        kind={kind}
        loaded={read.asset}
        reload={read.reload}
        onDeleted={onDeleted}
      />
    );
  }
  return (
    <Page ref={page.page.ref}>
      {page.page.above}
      {read.status === "loading" ? (
        <SkeletonPage />
      ) : (
        <>
          <PageHeader back={page.back} title={name} />
          {read.status === "missing" ? (
            <EmptyState icon={<SearchX aria-hidden="true" />}>
              {t(entry.missingText, { name })}
            </EmptyState>
          ) : (
            <InlineError className="flex flex-wrap items-center justify-between gap-2">
              <span>{read.message}</span>
              <Button variant="outline" size="sm" onClick={read.retry}>
                {t("tryAgain")}
              </Button>
            </InlineError>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * One loaded asset with everything the frame does to it. The revision it was loaded at stays
 * with this page: every write names it, and only this page's own save moves it on. A write
 * that meets a newer revision is answered with a notice, and the form keeps what was typed.
 */
function LoadedAssetPage({
  source,
  page,
  back,
  onUnsavedChange,
  kind,
  loaded,
  reload,
  onDeleted
}: AssetPageProps & {
  kind: VisibleBuildKind;
  loaded: BuildAsset;
  reload(): Promise<unknown>;
  onDeleted(): void;
}) {
  const { t } = useTranslation();
  const { entry, state } = kind;
  const [stored, setStored] = useState(loaded);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const address = { kind: entry.kind, name: stored.name };
  const canWrite = source.rights.may("write", stored);
  const canDelete = state.canDelete && source.rights.may("delete", stored);
  const Editor = entry.Editor;

  /** Reads what a write was refused for, and remembers a conflict for the notice. */
  const refusalOf = (error: unknown): BuildWriteOutcome => {
    const outcome = readBuildRefusal(error, t);
    if (!outcome.ok && outcome.conflict) {
      setConflict(true);
    }
    return outcome;
  };
  const loadNewer = () => {
    reload().catch(() => undefined);
  };
  const remove = async () => {
    setDeleting(true);
    try {
      await source.writes.delete({ ...address, expectedRevision: stored.revision });
      onDeleted();
    } catch (error) {
      const outcome = refusalOf(error);
      setDeleteOpen(false);
      setFailure(
        outcome.ok || outcome.conflict
          ? undefined
          : outcome.refusals.map((refusal) => refusal.message).join(" ")
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Editor
        page={page}
        back={back}
        asset={stored}
        start={undefined}
        canWrite={canWrite}
        instanceWrite={source.rights.instanceWrite}
        onUnsavedChange={onUnsavedChange}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <History aria-hidden="true" />
              {t("build.history")}
            </Button>
            {canDelete ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label={t("build.assetActions")} variant="outline" size="sm">
                    <MoreHorizontal aria-hidden="true" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={<Trash2 aria-hidden="true" />}
                    onSelect={() => setDeleteOpen(true)}
                  >
                    {t("configDelete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
        notice={
          conflict ? (
            <Banner
              tone="danger"
              data-build-conflict=""
              action={
                <Button variant="outline" size="sm" onClick={loadNewer}>
                  {t("build.loadNewer")}
                </Button>
              }
            >
              {t("build.conflict")}
            </Banner>
          ) : failure ? (
            <FormNotice tone="error">{failure}</FormNotice>
          ) : null
        }
        save={async (config) => {
          try {
            const { revision } = await source.writes.put({
              ...address,
              config,
              expectedRevision: stored.revision
            });
            setStored({ ...stored, config, revision });
            setConflict(false);
            setFailure(undefined);
            return { ok: true };
          } catch (error) {
            return refusalOf(error);
          }
        }}
      />
      <BuildHistory
        open={historyOpen}
        title={stored.name}
        currentRevision={stored.revision}
        load={() => source.writes.revisions(address)}
        onClose={() => setHistoryOpen(false)}
        onRestore={
          canWrite
            ? async (revision) => {
                try {
                  await source.writes.revert({
                    ...address,
                    revision,
                    expectedRevision: stored.revision
                  });
                } catch (error) {
                  const outcome = refusalOf(error);
                  if (!outcome.ok && outcome.conflict) {
                    setHistoryOpen(false);
                  }
                  return outcome;
                }
                // The restored content is the asset now: the drawer closes and the page starts
                // again from it.
                setHistoryOpen(false);
                await reload().catch(() => undefined);
                return { ok: true };
              }
            : undefined
        }
      />
      <ConfirmDialog
        open={deleteOpen}
        title={t(entry.deleteTitle, { name: stored.name })}
        confirmLabel={t("configDelete")}
        loading={deleting}
        onConfirm={() => {
          remove().catch(() => undefined);
        }}
        onClose={() => setDeleteOpen(false)}
      >
        {t(entry.deleteDescription)}
      </ConfirmDialog>
    </>
  );
}
