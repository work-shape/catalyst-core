import { ArrowLeft, MoreHorizontal, Plus, Search, SearchX, Terminal } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Avatar,
  Button,
  Card,
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
  Pagination,
  SkeletonList,
  SkeletonPage,
  SubRail
} from "@vivd-catalyst/ui";
import { configAssetMutationErrorMessage } from "../control-plane/config-assets-model";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { apiErrorStatus } from "../workspace-utils";
import type { BuildAsset, BuildAssetKind, BuildMutationOutcome } from "./build-asset-kind";
import { useBuildAssetKinds } from "./build-asset-kinds";
import type { BuildData } from "./build-data";
import {
  BUILD_LIST_PAGE_SIZE,
  buildListPage,
  formatUpdated,
  readLastBuildKindPath,
  resolveBuildPlace,
  storeLastBuildKindPath,
  visibleBuildKinds,
  type VisibleBuildKind
} from "./build-model";
import { useBuildNavigation } from "./build-route";

/** The commands the CLI entry names, in the order a person runs them. */
const CLI_COMMANDS = ["catalyst config pull", "catalyst config diff", "catalyst config push"];

/** What the reader typed and which page they were on, per kind, so the way back keeps both. */
interface ListView {
  query: string;
  page: number;
}

const firstListView: ListView = { query: "", page: 1 };

/**
 * The Build area: one list per kind and one page per asset, each with an address. The frame
 * owns the kind rail, the list with search and pages, the way back, the answer to a conflict
 * and every state; what a kind is comes from its registry entry.
 */
export function BuildFrame({ data }: { data: BuildData }) {
  const { t } = useTranslation();
  const { location, open, href } = useBuildNavigation();
  const kinds = visibleBuildKinds(useBuildAssetKinds(), data.kinds);
  const [lastKindPath] = useState(readLastBuildKindPath);
  const place = resolveBuildPlace(kinds, location, lastKindPath);
  const placePath = place?.kind.entry.path;
  const corrected = place?.corrected ?? false;

  const [listViews, setListViews] = useState<Record<string, ListView>>({});
  const [conflictOpen, setConflictOpen] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  // A new asset has no address yet: it is written on the list's address and ends with it.
  const locationKey = `${location.kindPath ?? ""}/${location.name ?? ""}`;
  const [creating, setCreating] = useState(false);
  const [seenLocationKey, setSeenLocationKey] = useState(locationKey);
  if (seenLocationKey !== locationKey) {
    setSeenLocationKey(locationKey);
    setCreating(false);
  }

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

  // Between a list and an asset the page changes under the reader: the focus goes to its
  // heading. The area focuses the first heading itself, and the rail keeps the focus on a kind.
  const pageRef = useRef<HTMLDivElement>(null);
  const focusKey = creating ? "new" : (place?.name ?? "");
  const focusedKey = useRef(focusKey);
  useEffect(() => {
    if (focusedKey.current === focusKey) {
      return;
    }
    const heading = pageRef.current?.querySelector("h1");
    if (heading) {
      focusedKey.current = focusKey;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [focusKey, data.loading]);

  if (!place) {
    return (
      <Page>
        <EmptyState>{t("build.noKinds")}</EmptyState>
      </Page>
    );
  }

  const { entry, state } = place.kind;
  const openList = () => {
    setCreating(false);
    open({ kindPath: entry.path });
  };
  const run = async (action: () => Promise<unknown>): Promise<BuildMutationOutcome> => {
    try {
      await action();
      return { ok: true };
    } catch (error) {
      if (apiErrorStatus(error) === 409) {
        setConflictOpen(true);
        return { ok: false };
      }
      return {
        ok: false,
        error: configAssetMutationErrorMessage(error, t("configChangeSaveFailed"))
      };
    }
  };
  const reloadAfterConflict = () => {
    data.reload().then(
      () => {
        setConflictOpen(false);
        setEditorVersion((version) => version + 1);
      },
      // A read that fails shows above the page; the question stays open.
      () => undefined
    );
  };
  const loadError = data.error ? (
    <InlineError className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <span>{data.error}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          data.reload().catch(() => undefined);
        }}
      >
        {t("tryAgain")}
      </Button>
    </InlineError>
  ) : null;

  const assetName = creating ? undefined : place.name;
  if (creating || assetName !== undefined) {
    const asset = state.assets.find((candidate) => candidate.name === assetName);
    const Editor = entry.Editor;
    const back = (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("build.backToList", { kind: t(entry.label) })}
        onClick={openList}
      >
        <ArrowLeft aria-hidden="true" />
        {t(entry.label)}
      </Button>
    );
    return (
      <Page ref={pageRef}>
        {loadError}
        {creating || asset ? (
          <Card className="min-w-0 overflow-hidden">
            <Editor
              key={`${editorVersion}:${entry.kind}:${asset?.name ?? ""}`}
              asset={asset}
              back={back}
              run={run}
              onCreated={(name) => open({ kindPath: entry.path, name })}
              onDeleted={() => open({ kindPath: entry.path }, { replace: true })}
              onReloaded={() => setEditorVersion((version) => version + 1)}
            />
          </Card>
        ) : data.loading ? (
          <SkeletonPage />
        ) : (
          <>
            <PageHeader back={back} title={assetName} />
            <EmptyState icon={<SearchX aria-hidden="true" />}>
              {t(entry.missingText, { name: assetName ?? "" })}
            </EmptyState>
          </>
        )}
        <Dialog
          open={conflictOpen}
          title={t("configChangedTitle")}
          onClose={() => setConflictOpen(false)}
          footer={
            <>
              <Button variant="outline" onClick={() => setConflictOpen(false)}>
                {t("configKeepEditing")}
              </Button>
              <Button onClick={reloadAfterConflict}>{t("configReloadLatest")}</Button>
            </>
          }
        >
          <p className="text-body text-muted-foreground">{t("configChangedDescription")}</p>
        </Dialog>
      </Page>
    );
  }

  const view = listViews[entry.path] ?? firstListView;
  return (
    <Page
      ref={pageRef}
      subRail={
        kinds.length > 1 ? (
          <SubRail
            mode="routes"
            label={t("build.kinds")}
            groups={[
              {
                id: "kinds",
                items: kinds.map((kind) => {
                  const Icon = kind.entry.icon;
                  return {
                    id: kind.entry.path,
                    label: t(kind.entry.label),
                    icon: <Icon aria-hidden="true" />,
                    count: data.loading ? undefined : kind.state.assets.length
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
        kind={place.kind}
        loading={data.loading}
        loadError={loadError}
        view={view}
        onViewChange={(next) => setListViews((views) => ({ ...views, [entry.path]: next }))}
        hrefOf={(asset) => href({ kindPath: entry.path, name: asset.name })}
        onOpen={(asset) => open({ kindPath: entry.path, name: asset.name })}
        onNew={() => setCreating(true)}
      />
    </Page>
  );
}

function BuildList({
  kind,
  loading,
  loadError,
  view,
  onViewChange,
  hrefOf,
  onOpen,
  onNew
}: {
  kind: VisibleBuildKind;
  loading: boolean;
  loadError: ReactNode;
  view: ListView;
  onViewChange(view: ListView): void;
  /** The address of an asset: a row is a link to it. */
  hrefOf(asset: BuildAsset): string;
  onOpen(asset: BuildAsset): void;
  onNew(): void;
}) {
  const { locale, t } = useTranslation();
  const { entry, state } = kind;
  const [cliOpen, setCliOpen] = useState(false);
  const [now] = useState(() => new Date());
  const texts = { t, locale };
  const list = buildListPage({
    entry,
    assets: state.assets,
    locale,
    query: view.query,
    page: view.page
  });
  const newButton = state.canCreate ? (
    <Button onClick={onNew}>
      <Plus aria-hidden="true" />
      {t(entry.newLabel)}
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title={t(entry.label)}
        primaryAction={newButton}
        overflow={
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
        }
      />
      {loadError}
      {loading ? (
        <SkeletonList rows={6} />
      ) : state.assets.length === 0 ? (
        loadError ? null : (
          <EmptyState icon={<entry.icon aria-hidden="true" />} action={newButton}>
            {t(state.canCreate ? entry.emptyText : entry.emptyReadOnlyText)}
          </EmptyState>
        )
      ) : (
        <div className="grid min-w-0 gap-3">
          <FilterBar
            search={
              <Input
                type="search"
                leadingIcon={<Search />}
                aria-label={t(entry.searchLabel)}
                placeholder={t(entry.searchLabel)}
                value={view.query}
                onChange={(event) => onViewChange({ query: event.currentTarget.value, page: 1 })}
              />
            }
            count={
              view.query.trim() === ""
                ? undefined
                : t("build.matchCount", {
                    count: list.total.toLocaleString(locale),
                    total: state.assets.length.toLocaleString(locale)
                  })
            }
          />
          {list.total === 0 ? (
            <EmptyState layout="inline">
              {t("build.noMatch", { query: view.query.trim() })}
            </EmptyState>
          ) : (
            <List aria-label={t(entry.label)}>
              {list.rows.map(({ asset, title }) => {
                const status = entry.status?.(asset, texts);
                const updatedAt = asset.summary?.updatedAt;
                return (
                  <ListRow
                    key={asset.name}
                    leading={<RowMark entry={entry} title={title} />}
                    title={title}
                    description={
                      <>
                        <code className="font-mono">{asset.name}</code>
                        {status ? ` · ${status}` : null}
                      </>
                    }
                    chips={entry.badges?.(asset, texts)}
                    time={
                      updatedAt ? (
                        <time
                          className="hidden sm:inline"
                          dateTime={updatedAt}
                          title={formatDateTime(updatedAt, locale)}
                        >
                          {formatUpdated(updatedAt, now, locale)}
                        </time>
                      ) : undefined
                    }
                    link={
                      <a
                        href={hrefOf(asset)}
                        onClick={(event) => {
                          if (opensHere(event)) {
                            event.preventDefault();
                            onOpen(asset);
                          }
                        }}
                      />
                    }
                  />
                );
              })}
            </List>
          )}
          {list.pageCount > 1 ? (
            <Pagination
              page={list.page}
              pageCount={list.pageCount}
              onPageChange={(page) => onViewChange({ query: view.query, page })}
              range={t("settings.paginationRange", {
                from: list.from,
                to: Math.min(list.from + BUILD_LIST_PAGE_SIZE - 1, list.total),
                total: list.total.toLocaleString(locale)
              })}
              labels={{
                rows: t("settings.paginationRows"),
                rowsPerPage: t("settings.paginationRowsPerPage"),
                previous: t("settings.paginationPrevious"),
                next: t("settings.paginationNext")
              }}
            />
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
function RowMark({ entry, title }: { entry: BuildAssetKind; title: string }) {
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
