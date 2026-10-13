import { MoreHorizontal, Plus, Search, SearchX, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Avatar,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FilterBar,
  IconButton,
  InlineError,
  Input,
  List,
  ListRow,
  Page,
  PageHeader,
  PageHeaderBack,
  Picker,
  PickerButton,
  SkeletonList,
  SkeletonPage,
  SubRail
} from "@vivd-catalyst/ui";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { holdLeaveGuard } from "../leave-guard";
import {
  isEditableKind,
  opensAssets,
  type BuildAssetRow,
  type BuildAssetStart,
  type BuildKind
} from "./build-asset-kind";
import { useBuildAssetKinds } from "./build-asset-kinds";
import {
  ExistingAssetPage,
  NewAssetPage,
  ViewedAssetPage,
  type BuildAssetCopy
} from "./build-asset-page";
import { BuildCreateDialog } from "./build-create-dialog";
import { buildCreateRequested, clearBuildCreateRequest } from "./build-create-request";
import { BUILD_SEARCH_DELAY_MS, type BuildListFilter, type BuildSource } from "./build-data";
import {
  formatUpdated,
  readLastBuildKindPath,
  resolveBuildPlace,
  storeLastBuildKindPath,
  visibleBuildKinds,
  type VisibleBuildKind
} from "./build-model";
import { useBuildNavigation } from "./build-route";
import { scrollPageToTop } from "./build-scroll";

/** The commands the CLI entry names, in the order a person runs them. */
const CLI_COMMANDS = ["catalyst config pull", "catalyst config diff", "catalyst config push"];

/** What the reader typed and chose, per kind, so the way back keeps both. */
type ListView = BuildListFilter;

const firstListView: ListView = { text: "", namespace: undefined };

/** The value of the Namespace filter that narrows nothing. */
const ALL_NAMESPACES = "";

/**
 * The Build area: one list per kind and one page per asset, each with an address. The frame
 * owns the kind rail, the list with search and pages, the dialog that starts an asset, the way
 * back, History, the delete, the answer to a conflict and every state; what a kind is comes
 * from its registry entry, and what the instance holds from `source`.
 */
export function BuildFrame({ source }: { source: BuildSource }) {
  const { t } = useTranslation();
  const { location, open, href } = useBuildNavigation();
  const kinds = visibleBuildKinds(useBuildAssetKinds(), source.kinds);
  const [lastKindPath] = useState(readLastBuildKindPath);
  const place = resolveBuildPlace(kinds, location, lastKindPath);
  const placePath = place?.kind.entry.path;
  const corrected = place?.corrected ?? false;

  const [listViews, setListViews] = useState<Record<string, ListView>>({});
  // A new asset has no address yet: it is written on the list's address and ends with it.
  const locationKey = `${location.kindPath ?? ""}/${location.name ?? ""}`;
  // A page outside Build may have asked for the dialog: the list it leads to opens with it.
  const [asking, setAsking] = useState(
    () => location.name === undefined && buildCreateRequested(location.kindPath)
  );
  useEffect(clearBuildCreateRequest, []);
  const [start, setStart] = useState<BuildAssetStart>();
  /** A shipped asset the reader asked to copy: the dialog that names the copy is open. */
  const [copying, setCopying] = useState<BuildAssetCopy>();
  const [seenLocationKey, setSeenLocationKey] = useState(locationKey);
  if (seenLocationKey !== locationKey) {
    setSeenLocationKey(locationKey);
    setAsking(false);
    setCopying(undefined);
    setStart(undefined);
  }
  const creating = start !== undefined;

  // The shell hands a new `open` with every render; the address is corrected once per place.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    if (placePath === undefined) {
      return;
    }
    if (corrected) {
      openRef.current({ kindPath: placePath }, { replace: true });
    } else {
      storeLastBuildKindPath(placePath);
    }
  }, [corrected, placePath]);

  // An editor with unsaved changes is not left without a question. The question is one promise:
  // the back button, the router and a second attempt while it is open all wait for one answer.
  const [unsaved, setUnsaved] = useState(false);
  const [leaveAsked, setLeaveAsked] = useState(false);
  const leaveQuestion = useRef<{ promise: Promise<boolean>; answer(leave: boolean): void }>(
    undefined
  );
  // Set by an exit that needs no question: the answer "discard", a save that opens the new
  // asset, a delete. It ends with the place it was set on.
  const leaveAllowed = useRef(false);
  const askToLeave = useCallback((): Promise<boolean> => {
    if (leaveAllowed.current) {
      return Promise.resolve(true);
    }
    if (leaveQuestion.current) {
      return leaveQuestion.current.promise;
    }
    let answer: (leave: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    leaveQuestion.current = { promise, answer };
    setLeaveAsked(true);
    return promise;
  }, []);
  const answerLeave = (leave: boolean) => {
    leaveAllowed.current = leave;
    leaveQuestion.current?.answer(leave);
    leaveQuestion.current = undefined;
    setLeaveAsked(false);
  };
  useEffect(() => {
    if (!unsaved) {
      return;
    }
    const release = holdLeaveGuard(askToLeave);
    // Closing or reloading the tab is the browser's own question.
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      release();
      window.removeEventListener("beforeunload", warn);
      leaveQuestion.current?.answer(true);
      leaveQuestion.current = undefined;
      setLeaveAsked(false);
    };
  }, [unsaved, askToLeave]);
  useEffect(() => {
    leaveAllowed.current = false;
  }, [locationKey, creating]);

  // Between a list and an asset the page changes under the reader: the focus goes to its
  // heading. The area focuses the first heading itself, and the rail keeps the focus on a kind.
  const pageRef = useRef<HTMLDivElement>(null);
  // An asset page tells when its heading stands: it is read after the frame rendered.
  const [shownCount, setShownCount] = useState(0);
  const pageShown = useCallback(() => setShownCount((count) => count + 1), []);
  const focusKey = creating ? "new" : (place?.name ?? "");
  const focusedKey = useRef(focusKey);
  useEffect(() => {
    if (focusedKey.current === focusKey) {
      return;
    }
    const heading = pageRef.current?.querySelector("h1");
    if (heading) {
      focusedKey.current = focusKey;
      scrollPageToTop(pageRef.current);
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [focusKey, source.loading, shownCount]);

  const loadError = source.error ? (
    <LoadError
      message={source.error}
      onRetry={() => {
        source.reload().catch(() => undefined);
      }}
    />
  ) : null;

  if (!place) {
    return (
      <Page ref={pageRef}>
        {loadError}
        {source.loading ? (
          <SkeletonPage />
        ) : loadError ? null : (
          <EmptyState>{t("build.noKinds")}</EmptyState>
        )}
      </Page>
    );
  }

  const { entry } = place.kind;
  const openList = () => {
    const leave = () => {
      setStart(undefined);
      open({ kindPath: entry.path });
    };
    if (!unsaved) {
      leave();
      return;
    }
    askToLeave().then(
      (answer) => {
        if (answer) {
          leave();
        }
      },
      () => undefined
    );
  };

  const assetName = creating ? undefined : place.name;
  const back = (
    <PageHeaderBack label={t("build.backToList", { kind: t(entry.label) })} onClick={openList}>
      {t(entry.label)}
    </PageHeaderBack>
  );
  if (!isEditableKind(entry) && entry.view && assetName !== undefined) {
    return (
      <ViewedAssetPage
        key={assetName}
        source={source}
        kind={entry.kind}
        view={entry.view}
        name={assetName}
        page={{ ref: pageRef, above: loadError, shown: pageShown }}
        back={back}
      />
    );
  }
  if (isEditableKind(entry) && (start !== undefined || assetName !== undefined)) {
    const leaveTo = (name: string | undefined) => {
      leaveAllowed.current = true;
      open({ kindPath: entry.path, name }, name === undefined ? { replace: true } : undefined);
    };
    const page = { ref: pageRef, above: loadError, shown: pageShown };
    return (
      <>
        {start !== undefined ? (
          <NewAssetPage
            source={source}
            entry={entry}
            start={start}
            page={page}
            back={back}
            onUnsavedChange={setUnsaved}
            onCreated={leaveTo}
          />
        ) : assetName !== undefined ? (
          <ExistingAssetPage
            key={assetName}
            source={source}
            kind={{ entry, state: place.kind.state }}
            name={assetName}
            page={page}
            back={back}
            onUnsavedChange={setUnsaved}
            onDeleted={() => leaveTo(undefined)}
            onCopy={setCopying}
          />
        ) : null}
        {copying && place.kind.state.canCreate ? (
          <BuildCreateDialog
            entry={entry}
            heading={t("build.copyToEdit")}
            initialTitle={t("build.copyTitle", { title: copying.title })}
            namespaces={source.rights.creatableNamespaces(entry.kind)}
            mayNameFreely={source.rights.instanceWrite}
            onClose={() => setCopying(undefined)}
            onStart={(chosen) => {
              setCopying(undefined);
              setStart({ ...chosen, copyOf: copying.config });
            }}
          />
        ) : null}
        <ConfirmDialog
          open={leaveAsked && unsaved}
          title={t("build.leaveTitle")}
          confirmLabel={t("build.leaveConfirm")}
          onConfirm={() => answerLeave(true)}
          onClose={() => answerLeave(false)}
        >
          {t("build.leaveDescription")}
        </ConfirmDialog>
      </>
    );
  }

  const view = listViews[entry.path] ?? firstListView;
  return (
    <Page
      ref={pageRef}
      subRail={
        kinds.length > 1 ? (
          <SubRail
            title={t("nav.build")}
            label={t("build.kinds")}
            groups={[
              {
                id: "kinds",
                items: kinds.map((kind) => {
                  const Icon = kind.entry.icon;
                  return {
                    id: kind.entry.path,
                    label: t(kind.entry.label),
                    icon: <Icon aria-hidden="true" />
                  };
                })
              }
            ]}
            value={entry.path}
            onValueChange={(kindPath) => open({ kindPath })}
          />
        ) : undefined
      }
    >
      <BuildList
        key={entry.path}
        source={source}
        kind={place.kind}
        loadError={loadError}
        view={view}
        onViewChange={(next) => setListViews((views) => ({ ...views, [entry.path]: next }))}
        hrefOf={(asset) => href({ kindPath: entry.path, name: asset.name })}
        onOpen={(asset) => open({ kindPath: entry.path, name: asset.name })}
        onNew={() => setAsking(true)}
      />
      {asking && isEditableKind(entry) && place.kind.state.canCreate ? (
        <BuildCreateDialog
          entry={entry}
          namespaces={source.rights.creatableNamespaces(entry.kind)}
          mayNameFreely={source.rights.instanceWrite}
          onClose={() => setAsking(false)}
          onStart={(chosen) => {
            setAsking(false);
            setStart(chosen);
          }}
        />
      ) : null}
    </Page>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <InlineError className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <span>{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("tryAgain")}
      </Button>
    </InlineError>
  );
}

/** What the reader typed, once they paused: the text the instance is asked with. */
function useSettledText(text: string): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (text === settled) {
      return;
    }
    const timer = window.setTimeout(() => setSettled(text), BUILD_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [settled, text]);
  return settled;
}

function BuildList({
  source,
  kind,
  loadError,
  view,
  onViewChange,
  hrefOf,
  onOpen,
  onNew
}: {
  source: BuildSource;
  kind: VisibleBuildKind;
  loadError: ReactNode;
  view: ListView;
  onViewChange(view: ListView): void;
  /** The address of an asset: a row is a link to it. */
  hrefOf(asset: BuildAssetRow): string;
  onOpen(asset: BuildAssetRow): void;
  onNew(): void;
}) {
  const { locale, t } = useTranslation();
  const { entry, state } = kind;
  const [cliOpen, setCliOpen] = useState(false);
  const [now] = useState(() => new Date());
  const settledText = useSettledText(view.text);
  const list = source.useList(entry.kind, { text: settledText, namespace: view.namespace });
  const { namespaces } = source.rights;
  const namespaceName = (prefix: string | undefined) =>
    namespaces.find((namespace) => namespace.prefix === prefix)?.displayName;
  const filtered = settledText.trim() !== "" || view.namespace !== undefined;
  // A kind that only lists has no asset to start and no CLI entry, and a page only to show one.
  const editable = isEditableKind(entry) ? entry : undefined;
  const opens = opensAssets(entry);
  const newButton =
    editable && state.canCreate ? (
      <Button onClick={onNew}>
        <Plus aria-hidden="true" />
        {t(editable.newLabel)}
      </Button>
    ) : undefined;
  const listError = list.error ? <LoadError message={list.error} onRetry={list.retry} /> : null;

  return (
    <>
      <PageHeader
        title={t(entry.label)}
        description={entry.description ? t(entry.description) : undefined}
        primaryAction={newButton}
        overflow={
          editable ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("build.listActions")} variant="outline">
                  <MoreHorizontal aria-hidden="true" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  icon={<Terminal aria-hidden="true" />}
                  onSelect={() => setCliOpen(true)}
                >
                  {t("build.cliTitle")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />
      {loadError}
      {listError}
      {list.rows === undefined ? (
        listError ? null : (
          <SkeletonList rows={6} />
        )
      ) : list.rows.length === 0 && !filtered ? (
        <EmptyState icon={<entry.icon aria-hidden="true" />} action={newButton}>
          {t(editable && !state.canCreate ? editable.emptyReadOnlyText : entry.emptyText)}
        </EmptyState>
      ) : (
        <div className="grid min-w-0 gap-3">
          <FilterBar
            search={
              <Input
                type="search"
                leadingIcon={<Search />}
                aria-label={t(entry.searchLabel)}
                placeholder={t(entry.searchLabel)}
                value={view.text}
                onChange={(event) => onViewChange({ ...view, text: event.currentTarget.value })}
              />
            }
            filters={
              namespaces.length > 1 ? (
                <Picker
                  search
                  label={t("build.namespaceFilter")}
                  options={[
                    { value: ALL_NAMESPACES, label: t("build.namespaceAll") },
                    ...namespaces.map((namespace) => ({
                      value: namespace.prefix,
                      label: namespace.displayName,
                      description: namespace.prefix
                    }))
                  ]}
                  value={view.namespace ?? ALL_NAMESPACES}
                  onValueChange={(prefix) =>
                    onViewChange({
                      ...view,
                      namespace: prefix === ALL_NAMESPACES ? undefined : prefix
                    })
                  }
                >
                  <PickerButton
                    label={t("build.namespaceFilter")}
                    value={namespaceName(view.namespace) ?? t("build.namespaceAll")}
                    placeholder={t("build.namespaceAll")}
                  />
                </Picker>
              ) : undefined
            }
          />
          {list.rows.length === 0 ? (
            <EmptyState layout="inline" icon={<SearchX aria-hidden="true" />}>
              {settledText.trim() === ""
                ? t("build.noMatchInNamespace")
                : t("build.noMatch", { query: settledText.trim() })}
            </EmptyState>
          ) : (
            <List aria-label={t(entry.label)}>
              {list.rows.map((asset) => {
                const title = asset.title.trim() || asset.name;
                const namespace = namespaceName(asset.namespace) ?? asset.namespace;
                const own = entry.row?.(asset);
                const rowText = entry.rowText?.(asset)?.trim();
                return (
                  <ListRow
                    key={asset.name}
                    leading={own?.leading ?? <RowMark entry={entry} title={title} />}
                    title={title}
                    description={
                      own ? (
                        own.description
                      ) : (
                        <>
                          <code className="font-mono">{asset.name}</code>
                          {rowText ? ` · ${rowText}` : null}
                        </>
                      )
                    }
                    chips={
                      <>
                        {namespace ? <Chip size="sm">{namespace}</Chip> : null}
                        {entry.badges?.(asset, t)}
                      </>
                    }
                    time={
                      <time
                        className="hidden sm:inline"
                        dateTime={asset.updatedAt}
                        title={formatDateTime(asset.updatedAt, locale)}
                      >
                        {formatUpdated(asset.updatedAt, now, locale)}
                      </time>
                    }
                    link={
                      opens ? (
                        <a
                          href={hrefOf(asset)}
                          onClick={(event) => {
                            if (opensHere(event)) {
                              event.preventDefault();
                              onOpen(asset);
                            }
                          }}
                        />
                      ) : undefined
                    }
                  />
                );
              })}
            </List>
          )}
          {list.hasMore ? (
            <Button
              variant="outline"
              className="justify-self-start"
              loading={list.loadingMore}
              onClick={list.loadMore}
            >
              {t("build.showMore")}
            </Button>
          ) : null}
        </div>
      )}
      {cliOpen ? (
        <Dialog
          open
          title={t("build.cliTitle")}
          description={t("build.cliDescription")}
          onClose={() => setCliOpen(false)}
        >
          <div className="grid gap-3">
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-code">
              {CLI_COMMANDS.join("\n")}
            </pre>
            <p className="text-body text-muted-foreground">{t("build.cliPushWarning")}</p>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** A plain click opens the page here. With a modifier or another button the browser decides. */
function opensHere(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** What stands before a row's name: the asset's own avatar, or the mark of its kind. */
function RowMark({ entry, title }: { entry: BuildKind; title: string }) {
  if (entry.avatar) {
    return <Avatar kind={entry.avatar} name={title} />;
  }
  const Icon = entry.icon;
  return (
    <span
      aria-hidden="true"
      className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground"
    >
      <Icon className="size-4" />
    </span>
  );
}
