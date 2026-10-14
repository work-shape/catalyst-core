import { Copy, History, Lock, MoreHorizontal, SearchX, Send, Trash2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import {
  Badge,
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
import { useTranslation, type TranslationKey } from "../i18n";
import { usePageShown } from "./asset-editor-shell";
import type {
  BuildAsset,
  BuildAssetKind,
  BuildAssetStart,
  BuildKind,
  BuildListedKind,
  BuildPageSlot
} from "./build-asset-kind";
import type { BuildAssetRead, BuildAssetReload, BuildSource } from "./build-data";
import { BuildHistory } from "./build-history";
import type { VisibleBuildKind } from "./build-model";
import { formatDateTime } from "../control-plane/locale-format";
import { readBuildRefusal, type BuildWriteOutcome } from "./build-refusals";
import { buildWorkspaceName } from "./build-rights";

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
      {...(source.scoped?.(entry.kind) && source.scope?.kind === "workspace"
        ? { owner: source.scope.workspaceId }
        : {})}
      onUnsavedChange={page.onUnsavedChange}
      save={async (config) => {
        const create = (expectedRevision: number | null) =>
          source.writes.put({
            kind: entry.kind,
            name: start.name,
            config,
            expectedRevision,
            ...(start.availableIn ? { availableIn: start.availableIn } : {})
          });
        try {
          try {
            await create(null);
          } catch (error) {
            // The id is held by a deleted asset. The reader chose the id for a new asset and
            // holds no older text of it, so the asset is created again after that delete, which
            // the instance has just told, and keeps its history.
            const met = readBuildRefusal(error, t);
            if (met.ok || !met.conflict || !met.deleted || met.currentRevision === undefined) {
              throw error;
            }
            await create(met.currentRevision);
          }
          onCreated(start.name);
          return { ok: true };
        } catch (error) {
          const outcome = readBuildRefusal(error, t);
          // A create that meets a conflict found the id taken, or held by a deleted asset
          // whose history the reader may not read.
          return !outcome.ok && outcome.conflict
            ? {
                ok: false,
                conflict: false,
                refusals: [
                  {
                    message: t(outcome.deleted ? "build.nameDeleted" : "build.nameTaken", {
                      name: start.name
                    })
                  }
                ]
              }
            : outcome;
        }
      }}
    />
  );
}

/** What "Copy to edit" starts from: the shipped asset's title and its definition. */
export interface BuildAssetCopy {
  title: string;
  config: Record<string, unknown>;
}

/** The page at an asset's address: the asset once it is read, and every state before that. */
export function ExistingAssetPage({
  kind,
  name,
  onDeleted,
  onCopy,
  ...page
}: AssetPageProps & {
  kind: VisibleBuildKind<BuildAssetKind>;
  name: string;
  onDeleted(): void;
  /** Starts a copy of an asset that ships with the platform. */
  onCopy(copy: BuildAssetCopy): void;
}) {
  const { entry } = kind;
  const read = page.source.useAsset(entry.kind, name);
  // The page starts again after a restore, so what it says of the restore is kept here.
  const [restored, setRestored] = useState<number>();
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
        restored={restored}
        onRestored={setRestored}
        onDeleted={onDeleted}
        onCopy={onCopy}
      />
    );
  }
  return (
    <UnreadAssetPage
      page={page.page}
      back={page.back}
      name={name}
      read={read}
      missingText={entry.missingText}
    />
  );
}

/**
 * The page at the address of an asset whose kind shows it and changes nothing: the kind's own
 * page once the asset is read, and every state before that.
 */
export function ViewedAssetPage({
  source,
  page,
  back,
  kind,
  view,
  name,
  kinds
}: Pick<AssetPageProps, "source" | "page" | "back"> & {
  kind: string;
  view: NonNullable<BuildListedKind["view"]>;
  name: string;
  kinds: readonly BuildKind[];
}) {
  const read = source.useAsset(kind, name);
  usePageShown(page, read.status);
  if (read.status === "ready") {
    return <view.Page page={page} back={back} asset={read.asset} kinds={kinds} />;
  }
  return (
    <UnreadAssetPage
      page={page}
      back={back}
      name={name}
      read={read}
      missingText={view.missingText}
    />
  );
}

/** An asset page before its asset is read: loading, missing, refused or failed. */
function UnreadAssetPage({
  page,
  back,
  name,
  read,
  missingText
}: {
  page: BuildPageSlot;
  back: ReactNode;
  name: string;
  read: Exclude<BuildAssetRead, { status: "ready" }>;
  missingText: TranslationKey;
}) {
  const { t } = useTranslation();
  return (
    <Page ref={page.ref}>
      {page.above}
      {read.status === "loading" ? (
        <SkeletonPage />
      ) : (
        <>
          <PageHeader back={back} title={name} />
          {read.status === "missing" ? (
            <EmptyState icon={<SearchX aria-hidden="true" />}>
              {t(missingText, { name })}
            </EmptyState>
          ) : read.status === "refused" ? (
            <EmptyState icon={<Lock aria-hidden="true" />}>{t("build.assetRefused")}</EmptyState>
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
  restored,
  onRestored,
  onDeleted,
  onCopy
}: AssetPageProps & {
  kind: VisibleBuildKind<BuildAssetKind>;
  loaded: BuildAsset;
  reload(): Promise<BuildAssetReload>;
  /** The revision a restore just made the content again. */
  restored: number | undefined;
  onRestored(revision: number | undefined): void;
  onDeleted(): void;
  onCopy(copy: BuildAssetCopy): void;
}) {
  const { locale, t } = useTranslation();
  const { entry, state } = kind;
  const [stored, setStored] = useState(loaded);
  // What stands between this page and the instance: somebody saved a newer revision, or
  // somebody deleted the asset. Either way the page keeps what was typed.
  const [conflict, setConflict] = useState<"saved" | "deleted">();
  /** Who wrote the revision the conflict is with and when, where the instance said so. */
  const [conflictBy, setConflictBy] = useState<{ name: string; time: string }>();
  const [reloadFailed, setReloadFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [loadAsked, setLoadAsked] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const address = { kind: entry.kind, name: stored.name };
  // An asset that ships with the platform is changed by a release alone, whoever reads it.
  const shippedTitle = entry.shippedTitle?.(stored);
  const shipped = shippedTitle !== undefined;
  const owner = stored.scope.kind === "workspace" ? stored.scope.workspaceId : undefined;
  const held = { kind: stored.kind, namespace: stored.namespace, workspaceId: owner };
  const canWrite = !shipped && source.rights.may("write", held);
  const namespace = source.rights.namespaces.find(
    (candidate) => candidate.prefix === stored.namespace
  );
  const workspaceName =
    owner === undefined
      ? undefined
      : buildWorkspaceName(source.rights, owner, t("build.scopePersonal"));
  const readOnlyReason = shipped
    ? t("build.readOnlyPlatform")
    : workspaceName !== undefined
      ? t("build.readOnlyWorkspace", { workspace: workspaceName })
      : stored.namespace === undefined
        ? t("build.readOnlyInstance")
        : t("build.readOnlyNamespace", { namespace: namespace?.displayName ?? stored.namespace });
  const canDelete = !shipped && state.canDelete && source.rights.may("delete", held);
  // A kind with drafts answers its two pointers. The saved draft is ahead of what is
  // published, or nothing is published yet.
  const hasDraft = stored.draftRevision !== undefined;
  const draftAhead = hasDraft && stored.revision !== stored.publishedRevision;
  const canPublish = draftAhead && conflict === undefined && source.rights.may("publish", held);
  const Editor = entry.Editor;
  const heardUnsaved = useCallback(
    (next: boolean) => {
      setUnsaved(next);
      onUnsavedChange(next);
    },
    [onUnsavedChange]
  );

  /** Reads what a write was refused for, and remembers a conflict for the notice. */
  const refusalOf = (error: unknown): BuildWriteOutcome => {
    const outcome = readBuildRefusal(error, t);
    if (!outcome.ok && outcome.conflict) {
      setConflict((known) => (outcome.deleted ? "deleted" : (known ?? "saved")));
      setConflictBy(
        outcome.changedBy !== undefined && outcome.changedAt !== undefined
          ? { name: outcome.changedBy, time: formatDateTime(outcome.changedAt, locale) }
          : undefined
      );
      setReloadFailed(false);
      // A conflict does not say whether the asset was saved or deleted. The notice says
      // which, so the instance is asked.
      source.exists(address.kind, address.name).then(
        (exists) => {
          if (exists === false) {
            setConflict("deleted");
            // Who and when were told of a save. Nobody told this page of the delete after it.
            if (!outcome.deleted) setConflictBy(undefined);
          }
        },
        () => undefined
      );
    }
    return outcome;
  };
  const loadNewer = async () => {
    setReloading(true);
    // A newer asset starts this page again. After any other answer it stays as it is.
    const answer = await reload().catch((): BuildAssetReload => "failed");
    setReloading(false);
    setLoadAsked(false);
    if (answer === "missing") {
      setConflict("deleted");
      setConflictBy(undefined);
      setReloadFailed(false);
    } else if (answer === "failed") {
      setReloadFailed(true);
    }
  };
  const publish = async () => {
    setPublishing(true);
    try {
      const pointers = await source.writes.publish({ ...address, revision: stored.revision });
      setStored({ ...stored, ...pointers });
      setFailure(undefined);
    } catch (error) {
      const outcome = readBuildRefusal(error, t);
      setFailure(
        outcome.ok || outcome.conflict
          ? t("build.publishFailed")
          : outcome.refusals.map((refusal) => refusal.message).join(" ")
      );
    } finally {
      setPublishing(false);
      setPublishOpen(false);
    }
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
        readOnlyReason={canWrite ? undefined : readOnlyReason}
        saveBlocked={conflict !== undefined}
        instanceWrite={source.rights.instanceWrite}
        {...(owner === undefined ? {} : { owner })}
        onUnsavedChange={heardUnsaved}
        draftState={
          draftAhead ? (
            <Badge tone="warning" data-build-draft-state="">
              {t(
                stored.publishedRevision === undefined ? "build.neverPublished" : "build.draftAhead"
              )}
            </Badge>
          ) : undefined
        }
        actions={
          <>
            {canPublish ? (
              <Button
                size="sm"
                data-build-publish=""
                disabled={unsaved}
                title={unsaved ? t("build.publishSaveFirst") : undefined}
                onClick={() => setPublishOpen(true)}
              >
                <Send aria-hidden="true" />
                {t("build.publish")}
              </Button>
            ) : null}
            {shipped && state.canCreate ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCopy({ title: shippedTitle, config: stored.config })}
              >
                <Copy aria-hidden="true" />
                {t("build.copyToEdit")}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <History aria-hidden="true" />
              {t("build.history")}
            </Button>
            {canDelete && conflict !== "deleted" ? (
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
          conflict === "deleted" ? (
            <Banner
              tone="warning"
              data-build-conflict="deleted"
              action={
                <Button variant="outline" size="sm" onClick={onDeleted}>
                  {t("build.backToList", { kind: t(entry.label) })}
                </Button>
              }
            >
              {conflictBy ? t("build.conflictDeletedBy", conflictBy) : t("build.conflictDeleted")}
            </Banner>
          ) : conflict === "saved" ? (
            <>
              <Banner
                tone="warning"
                data-build-conflict="saved"
                action={
                  <>
                    <Button variant="outline" size="sm" onClick={() => setLoadAsked(true)}>
                      {t("build.loadNewer")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-build-conflict-history=""
                      onClick={() => setHistoryOpen(true)}
                    >
                      {t("build.openHistory")}
                    </Button>
                  </>
                }
              >
                {conflictBy ? t("build.conflictBy", conflictBy) : t("build.conflict")}
              </Banner>
              {reloadFailed ? (
                <FormNotice tone="error" data-build-reload-failed="">
                  {t("build.loadNewerFailed")}
                </FormNotice>
              ) : null}
            </>
          ) : failure ? (
            <FormNotice tone="error">{failure}</FormNotice>
          ) : restored !== undefined ? (
            <Banner
              tone="success"
              data-build-restored={restored}
              onDismiss={() => onRestored(undefined)}
            >
              {t("build.restored", { number: restored })}
            </Banner>
          ) : null
        }
        save={async (config) => {
          try {
            const { revision } = await source.writes.put({
              ...address,
              config,
              expectedRevision: stored.revision
            });
            // A save of a kind with drafts moves the draft, and nothing of what is published.
            setStored({
              ...stored,
              config,
              revision,
              ...(hasDraft ? { draftRevision: revision } : {})
            });
            setFailure(undefined);
            onRestored(undefined);
            return { ok: true };
          } catch (error) {
            return refusalOf(error);
          }
        }}
      />
      <BuildHistory
        open={historyOpen}
        title={stored.name}
        heldRevision={stored.revision}
        load={(cursor) => source.writes.revisions({ ...address, cursor })}
        onClose={() => setHistoryOpen(false)}
        onRestore={
          canWrite && conflict === undefined
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
                onRestored(revision);
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
      <ConfirmDialog
        open={publishOpen}
        tone="primary"
        title={t("build.publishTitle", { name: stored.name })}
        confirmLabel={t("build.publish")}
        loading={publishing}
        onConfirm={() => {
          publish().catch(() => undefined);
        }}
        onClose={() => setPublishOpen(false)}
      >
        {t("build.publishDescription")}
      </ConfirmDialog>
      <ConfirmDialog
        open={loadAsked}
        tone="primary"
        title={t("build.loadNewerTitle")}
        confirmLabel={t("build.loadNewer")}
        loading={reloading}
        onConfirm={() => {
          loadNewer().catch(() => undefined);
        }}
        onClose={() => setLoadAsked(false)}
      >
        {t("build.loadNewerDescription")}
      </ConfirmDialog>
    </>
  );
}
