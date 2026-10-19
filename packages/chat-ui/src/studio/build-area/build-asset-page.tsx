import { Copy, History, Lock, SearchX, Send, Trash2 } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  EmptyState,
  FormNotice,
  InlineError,
  NotFound,
  Page,
  PageHeader,
  SkeletonPage
} from "@work-shape/catalyst-ui";
import type {
  AssetContent,
  AssetFileEntry,
  DependencyConsent
} from "../../shared/api/asset-writes";
import { opensHere } from "../apps/app-header";
import { CopyIdItem } from "../copy-id-item";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
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
import { assetConfigTitle, type VisibleBuildKind } from "./build-model";
import { formatDateTime } from "../../shared/locale-format";
import { readBuildRefusal, type BuildWriteOutcome } from "./build-refusals";
import { AGENT_ASSET_KIND, buildWorkspaceName, type BuildRights } from "../../shared/build-rights";

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
  const { source } = page;
  const scope = source.scopeOf?.(entry.kind);
  const Editor = entry.Editor;
  const create = useCreate({ entry, start, source, onCreated });
  return (
    <Editor
      page={page.page}
      back={page.back}
      actions={{}}
      notice={null}
      asset={undefined}
      start={start}
      canWrite
      instanceWrite={source.rights.instanceWrite}
      {...(scope?.kind === "workspace" ? { owner: scope.workspaceId } : {})}
      onUnsavedChange={page.onUnsavedChange}
      save={(config, write) =>
        create(
          { config },
          write !== undefined && "dependencyConsent" in write ? write.dependencyConsent : undefined
        )
      }
      folder={{ read: async () => [], save: (files) => create({ files }) }}
    />
  );
}

/** Creates a new asset from its config or its folder, and opens its page. */
function useCreate({
  entry,
  start,
  source,
  onCreated
}: {
  entry: BuildAssetKind;
  start: BuildAssetStart;
  source: BuildSource;
  onCreated(name: string): void;
}): (content: AssetContent, dependencyConsent?: DependencyConsent) => Promise<BuildWriteOutcome> {
  const { locale, t } = useTranslation();
  return async (content, dependencyConsent) => {
    const create = (expectedRevision: number | null) =>
      source.writes.put({
        kind: entry.kind,
        name: start.name,
        ...content,
        expectedRevision,
        ...(start.availableIn ? { availableIn: start.availableIn } : {}),
        ...(dependencyConsent ? { dependencyConsent } : {})
      });
    try {
      try {
        await create(null);
      } catch (error) {
        // The id is held by a deleted asset. The reader chose the id for a new asset and
        // holds no older text of it, so the asset is created again after that delete, which
        // the instance has just told, and keeps its history.
        const met = readBuildRefusal(error, t, locale);
        if (met.ok || !met.conflict || !met.deleted || met.currentRevision === undefined) {
          throw error;
        }
        await create(met.currentRevision);
      }
      onCreated(start.name);
      return { ok: true };
    } catch (error) {
      const outcome = readBuildRefusal(error, t, locale);
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
  };
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
  toList,
  onDeleted,
  onCopy,
  ...page
}: AssetPageProps & {
  kind: VisibleBuildKind<BuildAssetKind>;
  name: string;
  /** The kind's list: where a page without its asset leads. */
  toList: { href: string; open(): void };
  onDeleted(): void;
  /** Starts a copy of an asset that ships with the platform. */
  onCopy(copy: BuildAssetCopy): void;
}) {
  const { entry } = kind;
  const read = page.source.useAsset(entry.kind, name);
  // The page starts again after a restore, so what it says of the restore is kept here.
  const [restored, setRestored] = useState<number>();
  usePageShown(page.page, read.status);
  const { t } = useTranslation();

  if (read.status === "missing" && entry.kind === AGENT_ASSET_KIND) {
    // No head that names the address: the sentence and the way back to the list stand alone,
    // in the middle of the page.
    return (
      <div ref={page.page.ref} className="flex min-h-full flex-col">
        {page.page.above}
        <NotFound
          action={
            <Button asChild>
              <a
                href={toList.href}
                onClick={(event) => {
                  if (opensHere(event)) {
                    event.preventDefault();
                    toList.open();
                  }
                }}
              >
                {t("build.backToList", { kind: t(entry.label) })}
              </a>
            </Button>
          }
        >
          {t(entry.missingText)}
        </NotFound>
      </div>
    );
  }
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
  const { locale, t } = useTranslation();
  const read = source.useAsset(kind, name);
  usePageShown(page, read.status);
  if (read.status === "ready") {
    const { asset } = read;
    const draftAhead =
      asset.draftRevision !== undefined && asset.revision !== asset.publishedRevision;
    const publish =
      draftAhead && mayOnAsset(source.rights, "publish", asset)
        ? async (): Promise<string | undefined> => {
            try {
              await source.writes.publish({ kind, name, revision: asset.revision });
            } catch (error) {
              const outcome = readBuildRefusal(error, t, locale);
              return outcome.ok || outcome.conflict
                ? t("build.publishFailed")
                : outcome.refusals.map((refusal) => refusal.message).join(" ");
            }
            await read.reload().catch(() => undefined);
            return undefined;
          }
        : undefined;
    return (
      <view.Page
        page={page}
        back={back}
        asset={asset}
        kinds={kinds}
        {...(publish === undefined ? {} : { publish })}
      />
    );
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
  const canWrite = !shipped && mayOnAsset(source.rights, "write", stored);
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
  const canDelete = !shipped && state.canDelete && mayOnAsset(source.rights, "delete", stored);
  // A kind with drafts answers its two pointers. The saved draft is ahead of what is
  // published, or nothing is published yet.
  const hasDraft = stored.draftRevision !== undefined;
  const draftAhead = hasDraft && stored.revision !== stored.publishedRevision;
  const canPublish =
    draftAhead && conflict === undefined && mayOnAsset(source.rights, "publish", stored);
  // The agent's draft revision the page shows, which a restore names: an agent has one draft,
  // and an earlier revision becomes its content.
  const agentDraftRead = useRef<number | null>(stored.agentDraft?.revision ?? null);
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
    const outcome = readBuildRefusal(error, t, locale);
    // A draft somebody else wrote is the agent page's to say: the live agent may be as read.
    if (!outcome.ok && outcome.conflict && !outcome.draft) {
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

  /**
   * Saves the config or the whole folder against the revision the page loaded. A save of a
   * kind with drafts moves the draft, and nothing of what is published. After a folder write
   * the page keeps the config it loaded: the instance read the new one from the files, and the
   * editor holds what was saved. A save of an agent's draft leaves the live agent the page
   * loaded as it is: the next save names it again, beside the draft revision this one wrote.
   */
  const write = async (
    content: AssetContent,
    draft?: { expectedDraftRevision: number | null }
  ): Promise<
    BuildWriteOutcome & { stored?: readonly AssetFileEntry[]; draftRevision?: number }
  > => {
    try {
      const { revision, draftRevision, files } = await source.writes.put({
        ...address,
        ...content,
        expectedRevision: stored.revision,
        ...(draft ?? {})
      });
      if (draft !== undefined && draftRevision !== undefined) {
        agentDraftRead.current = draftRevision;
        setFailure(undefined);
        onRestored(undefined);
        return { ok: true, draftRevision };
      }
      setStored({
        ...stored,
        ...("config" in content ? { config: content.config } : {}),
        revision,
        ...(hasDraft ? { draftRevision: revision } : {})
      });
      setFailure(undefined);
      onRestored(undefined);
      return { ok: true, ...(files ? { stored: files } : {}) };
    } catch (error) {
      return refusalOf(error);
    }
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
      const outcome = readBuildRefusal(error, t, locale);
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
        canPublish={!shipped && mayOnAsset(source.rights, "publish", stored)}
        onDraftRead={(revision) => {
          agentDraftRead.current = revision;
        }}
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
        actions={{
          primaryAction: canPublish ? (
            <Button
              data-build-publish=""
              disabled={unsaved}
              title={unsaved ? t("build.publishSaveFirst") : undefined}
              onClick={() => setPublishOpen(true)}
            >
              <Send aria-hidden="true" />
              {t("build.publish")}
            </Button>
          ) : shipped && state.canCreate ? (
            // A shipped asset is changed in a copy, the step its notice names: it stays in the
            // head where the other actions fold.
            <Button
              variant="outline"
              onClick={() => onCopy({ title: shippedTitle, config: stored.config })}
            >
              <Copy aria-hidden="true" />
              {t("build.copyToEdit")}
            </Button>
          ) : undefined,
          secondaryActions: [
            {
              label: t("build.history"),
              icon: <History aria-hidden="true" />,
              onSelect: () => setHistoryOpen(true)
            }
          ],
          menu:
            conflict === "deleted" ? undefined : (
              <>
                <CopyIdItem id={stored.name} />
                {canDelete ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      tone="danger"
                      icon={<Trash2 aria-hidden="true" />}
                      onSelect={() => setDeleteOpen(true)}
                    >
                      {t("configDelete")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </>
            )
        }}
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
        save={(config, draft) =>
          write(
            { config },
            draft !== undefined && "expectedDraftRevision" in draft ? draft : undefined
          )
        }
        reload={reload}
        folder={{
          read: () => source.writes.readFiles(address),
          save: (files) => write({ files })
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
                    expectedRevision: stored.revision,
                    ...(entry.kind === AGENT_ASSET_KIND
                      ? { expectedDraftRevision: agentDraftRead.current }
                      : {})
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
        title={t("build.publishTitle", { name: assetConfigTitle(stored, locale) })}
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

/** What the instance names a caller may do to an asset beyond reading it. */
type AssetChange = Exclude<NonNullable<BuildAsset["allowed"]>[number], "read">;

/**
 * What the reader may do to the asset on the page. The instance says it with the read, decided
 * on this asset with every grant and deny there is, those on the asset itself included. An
 * instance from before AD-4 says nothing, and the rights Studio resolved decide.
 */
function mayOnAsset(rights: BuildRights, verb: AssetChange, asset: BuildAsset): boolean {
  if (asset.allowed !== undefined) return asset.allowed.includes(verb);
  return rights.may(verb, {
    kind: asset.kind,
    namespace: asset.namespace,
    workspaceId: asset.scope.kind === "workspace" ? asset.scope.workspaceId : undefined
  });
}
