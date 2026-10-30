import { FolderInput, Plus, Search, SearchX, Terminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenuItem,
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
  RegistryIcon,
  SkeletonList,
  SkeletonPage,
  SubRail
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import { useOfferDockCreationScope } from "../../shared/dock-page-chat";
import { holdLeaveGuard } from "../../shared/leave-guard";
import {
  isEditableKind,
  opensAssets,
  type BuildAssetRow,
  type BuildAssetStart,
  type BuildKind,
  type BuildListLead
} from "./build-asset-kind";
import { useBuildAssetKinds } from "./build-asset-kinds";
import {
  ExistingAssetPage,
  NewAssetPage,
  ViewedAssetPage,
  mayOnAsset,
  type BuildAssetCopy
} from "./build-asset-page";
import { BuildCreateDialog, emptyAssetStart } from "./build-create-dialog";
import {
  clearBuildCreateDialogRequest,
  clearBuildStartRequest,
  requestedBuildStart,
  useBuildCreateDialogRequest
} from "./build-create-request";
import { BUILD_SEARCH_DELAY_MS, type BuildListFilter, type BuildSource } from "./build-data";
import {
  formatUpdated,
  resolveBuildPlace,
  visibleBuildKinds,
  type VisibleBuildKind
} from "./build-model";
import { useBuildNavigation } from "../../shared/build-route";
import {
  buildScopeValue,
  buildScopes,
  buildWorkspaceName,
  type BuildScope
} from "../../shared/build-rights";
import { readBuildRefusal } from "./build-refusals";
import { AssetPlaceLine, AssetPlacesProvider, assetPlace } from "./asset-place";
import { scrollPageToTop } from "./build-scroll";
import { BUILT_WITH_AGENT, BuildListEmpty } from "./build-list-empty";
import { BuildWithAgentDialog } from "../build-with-agent-dialog";
import { CAPABILITIES_BUILD_PATH, CapabilitiesPage } from "./capabilities-page";

/** The commands the CLI entry names, in the order a person runs them. */
const CLI_COMMANDS = ["catalyst config pull", "catalyst config diff", "catalyst config push"];

/** What the reader typed and chose, per kind, so the way back keeps both. */
type ListView = BuildListFilter;

const firstListView: ListView = { text: "" };

/**
 * The Build area: one list per kind and one page per asset, each with an address. The frame
 * owns the kind rail, the list with search and pages, the dialog that starts an asset, the way
 * back, History, the delete, the answer to a conflict and every state; what a kind is comes
 * from its registry entry, and what the instance holds from `source`.
 */
export function BuildFrame(props: {
  source: BuildSource;
  /** The shared workspace the reader works in: a new agent starts available there. */
  workspace?: { id: string; name: string };
}) {
  // Every page of Studio names a place by the workspaces the reader is shown.
  return (
    <AssetPlacesProvider value={props.source.rights.workspaces}>
      <BuildFrameBody {...props} />
    </AssetPlacesProvider>
  );
}

function BuildFrameBody({
  source,
  workspace
}: {
  source: BuildSource;
  workspace?: { id: string; name: string };
}) {
  const { locale, t } = useTranslation();
  const { location, open, href } = useBuildNavigation();
  const kinds = visibleBuildKinds(useBuildAssetKinds(), source.kinds);
  // "Fähigkeiten" stands below the kinds and is no kind: its address names no place of one.
  const onCapabilities = location.kindPath === CAPABILITIES_BUILD_PATH;
  const place = onCapabilities ? undefined : resolveBuildPlace(kinds, location);
  const placePath = place?.kind.entry.path;
  const corrected = place?.corrected ?? false;
  // The chat builds where Studio is set: a conversation it starts here is made in that owner,
  // and the empty dock names it.
  const offeredScope = place === undefined ? undefined : source.scopeOf?.(place.kind.entry.kind);
  useOfferDockCreationScope(
    offeredScope === undefined || place === undefined
      ? undefined
      : offeredScope.kind === "workspace"
        ? {
            owner: "workspace",
            workspaceId: offeredScope.workspaceId,
            workspaceName: buildWorkspaceName(
              source.rights,
              offeredScope.workspaceId,
              t("build.placeMine")
            )
          }
        : { owner: "instance", mayCreate: place.kind.state.canCreate }
  );

  const [listViews, setListViews] = useState<Record<string, ListView>>({});
  // A new asset has no address yet: it is written on the list's address and ends with it.
  const locationKey = `${location.kindPath ?? ""}/${location.name ?? ""}`;
  const [asking, setAsking] = useState(false);
  /** The kind's import dialog is open over its list. */
  const [importing, setImporting] = useState(false);
  // A page outside Studio may have started an asset in its own dialog: the list it leads to
  // opens the new asset's page.
  const [start, setStart] = useState<BuildAssetStart | undefined>(() =>
    location.name === undefined ? requestedBuildStart(location.kindPath) : undefined
  );
  useEffect(clearBuildStartRequest, []);
  /** A shipped asset the reader asked to copy: the dialog that names the copy is open. */
  const [copying, setCopying] = useState<BuildAssetCopy>();
  const [seenLocationKey, setSeenLocationKey] = useState(locationKey);
  if (seenLocationKey !== locationKey) {
    setSeenLocationKey(locationKey);
    setAsking(false);
    setImporting(false);
    setCopying(undefined);
    setStart(undefined);
  }
  const creating = start !== undefined;
  // A kind's own New dialog asked for from outside Studio opens over its list.
  const dialogAsked = useBuildCreateDialogRequest(
    location.name === undefined ? location.kindPath : undefined
  );
  useEffect(() => {
    if (!dialogAsked) return;
    clearBuildCreateDialogRequest();
    setAsking(true);
  }, [dialogAsked]);
  // What a kind's own dialog asked to run once the page of the asset it made is open.
  const afterOpen = useRef<{ name: string; then(): void }>(undefined);
  useEffect(() => {
    const pending = afterOpen.current;
    if (pending && location.name === pending.name) {
      afterOpen.current = undefined;
      pending.then();
    }
  }, [location.name]);

  // The shell hands a new `open` with every render; the address is corrected once per place.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    if (placePath !== undefined && corrected) {
      openRef.current({ kindPath: placePath }, { replace: true });
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

  // The kinds, and below them "Fähigkeiten", which shows what the kinds' agents can be given.
  const rail = (value: string) =>
    kinds.length === 0 ? undefined : (
      <SubRail
        title={t("nav.build")}
        label={t("build.kinds")}
        groups={[
          {
            id: "kinds",
            items: kinds.map((kind) => ({
              id: kind.entry.path,
              label: t(kind.entry.label),
              icon: <RegistryIcon name={kind.entry.icon} />
            }))
          },
          {
            id: "capabilities",
            items: [
              {
                id: CAPABILITIES_BUILD_PATH,
                label: t("capabilities.title"),
                icon: <RegistryIcon name="tool" />
              }
            ]
          }
        ]}
        value={value}
        onValueChange={(kindPath) => open({ kindPath })}
      />
    );

  if (onCapabilities) {
    return (
      <Page ref={pageRef} subRail={rail(CAPABILITIES_BUILD_PATH)}>
        {loadError}
        <CapabilitiesPage />
      </Page>
    );
  }

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
  // A new asset and a copy start where the dialog says: of a kind that starts in the workspace,
  // in the one the reader works in, or in the workspace of the scope, where the reader is a
  // member; made in one the reader is no member of, it starts hidden.
  const scope = source.scopeOf?.(entry.kind);
  const scopeWorkspace =
    scope?.kind === "workspace"
      ? source.rights.workspaces.find((candidate) => candidate.id === scope.workspaceId)
      : undefined;
  const startsIn =
    isEditableKind(entry) && entry.startsInWorkspace
      ? {
          workspace:
            scope?.kind === "workspace"
              ? scopeWorkspace?.member
                ? {
                    id: scopeWorkspace.id,
                    name: buildWorkspaceName(source.rights, scopeWorkspace.id, t("build.placeMine"))
                  }
                : undefined
              : workspace,
          mayChooseAll: source.rights.instanceWrite,
          ...(scopeWorkspace?.personal ? { onlyMine: true } : {})
        }
      : undefined;
  // "New" of a kind with a page and no dialog of its own opens the page empty: its first save
  // creates the asset, and makes it available where the reader works.
  if (asking && isEditableKind(entry) && place.kind.state.canCreate && !entry.CreateDialog) {
    setAsking(false);
    setStart(emptyAssetStart(startsIn));
  }
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
        kinds={kinds.map((kind) => kind.entry)}
        canDelete={place.kind.state.canDelete}
        onDeleted={() => open({ kindPath: entry.path }, { replace: true })}
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
            startsIn={startsIn}
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
            toList={{ href: href({ kindPath: entry.path }), open: openList }}
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
            startsIn={startsIn}
            checkName={(name) => source.checkName(entry.kind, name)}
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
  const briefed =
    !isEditableKind(entry) && place.kind.state.canCreate ? BUILT_WITH_AGENT[entry.kind] : undefined;
  return (
    <Page ref={pageRef} subRail={rail(entry.path)}>
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
        onImport={() => setImporting(true)}
      />
      {importing && isEditableKind(entry) && place.kind.state.canCreate && entry.importDialog ? (
        <entry.importDialog.Dialog
          checkName={async (name) => {
            const answer = await source.checkName(entry.kind, name);
            if (!answer.available && answer.reason === "name_taken") {
              // The availability check hides deleted state. Only an authorized history read
              // can let the import reach the recreate handler below; a refusal stays taken.
              const history = await source.writes
                .revisions({ kind: entry.kind, name })
                .catch(() => undefined);
              if (history?.items[0]?.operation === "delete") return { available: true };
            }
            return answer;
          }}
          create={async ({ name, files }) => {
            const create = (expectedRevision: number | null) =>
              source.writes.put({ kind: entry.kind, name, files, expectedRevision });
            try {
              let stored: { revision: number };
              try {
                stored = await create(null);
              } catch (error) {
                // The address is held by a deleted asset, as on a page opened empty: the import
                // creates it again after that delete, which the instance has just told, and it
                // keeps its history.
                const met = readBuildRefusal(error, t, locale);
                if (met.ok || !met.conflict || !met.deleted || met.currentRevision === undefined) {
                  throw error;
                }
                stored = await create(met.currentRevision);
              }
              return { ok: true, revision: stored.revision };
            } catch (error) {
              const outcome = readBuildRefusal(error, t, locale);
              // A create that meets a conflict found the address taken in the meantime.
              return !outcome.ok && outcome.conflict
                ? {
                    ok: false,
                    conflict: false,
                    refusals: [{ message: t("build.addressTaken") }]
                  }
                : outcome;
            }
          }}
          existing={async (name) => {
            const asset = await source.peek?.(entry.kind, name);
            if (asset === undefined) return undefined;
            const shipped = entry.shippedTitle?.(asset);
            const { title } = asset.config;
            return {
              title: shipped ?? (typeof title === "string" && title.trim() ? title : asset.name),
              // A shipped asset is changed by a release alone.
              writable: shipped === undefined && mayOnAsset(source.rights, "write", asset)
            };
          }}
          onClose={() => setImporting(false)}
          onOpen={(name) => {
            setImporting(false);
            open({ kindPath: entry.path, name });
          }}
        />
      ) : null}
      {asking && isEditableKind(entry) && place.kind.state.canCreate && entry.CreateDialog ? (
        <entry.CreateDialog
          checkName={(name) => source.checkName(entry.kind, name)}
          put={(input) => source.writes.put({ ...input, kind: entry.kind })}
          remove={(input) => source.writes.delete({ ...input, kind: entry.kind })}
          mayDelete={() =>
            place.kind.state.canDelete &&
            source.rights.may("delete", {
              kind: entry.kind,
              ...(scope?.kind === "workspace" ? { workspaceId: scope.workspaceId } : {})
            })
          }
          existing={async (name) => {
            const asset = await source.peek?.(entry.kind, name);
            if (asset === undefined) return undefined;
            // A shipped asset is changed by a release alone.
            const shipped = entry.shippedTitle?.(asset) !== undefined;
            return {
              name: asset.name,
              config: asset.config,
              revision: asset.revision,
              mayWrite: !shipped && mayOnAsset(source.rights, "write", asset),
              mayDelete:
                !shipped && place.kind.state.canDelete && mayOnAsset(source.rights, "delete", asset)
            };
          }}
          onClose={() => setAsking(false)}
          onCreated={(name, then) => {
            setAsking(false);
            afterOpen.current = then ? { name, then } : undefined;
            open({ kindPath: entry.path, name });
          }}
        />
      ) : asking && briefed && source.buildWithAgent ? (
        <BuildWithAgentDialog
          title={t(briefed.label)}
          prompt={t(briefed.prompt)}
          onBuild={source.buildWithAgent}
          onClose={() => setAsking(false)}
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

/** A kind that adds no rows of its own to its list. */
const NO_LEAD: BuildListLead = { rows: [] };

function BuildList({
  source,
  kind,
  loadError,
  view,
  onViewChange,
  hrefOf,
  onOpen,
  onNew,
  onImport
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
  /** Opens the kind's import dialog. */
  onImport(): void;
}) {
  const { locale, t } = useTranslation();
  const { entry, state } = kind;
  const [cliOpen, setCliOpen] = useState(false);
  const [now] = useState(() => new Date());
  const settledText = useSettledText(view.text);
  const list = source.useList(entry.kind, { text: settledText });
  // A row that offers its delete in place, such as an incomplete Connection (`rowRemovable`).
  const [removing, setRemoving] = useState<BuildAssetRow>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const rowRemovable = (asset: BuildAssetRow) =>
    isEditableKind(entry) &&
    entry.rowRemovable?.(asset) === true &&
    state.canDelete &&
    (asset.allowed?.includes("delete") ?? false);
  const removeRow = async (asset: BuildAssetRow) => {
    setRemoveBusy(true);
    setRemoveError(undefined);
    try {
      await source.writes.delete({
        kind: entry.kind,
        name: asset.name,
        expectedRevision: asset.revision
      });
      setRemoving(undefined);
    } catch (error) {
      const outcome = readBuildRefusal(error, t, locale);
      setRemoving(undefined);
      setRemoveError(
        outcome.ok
          ? t("build.deleteFailed")
          : outcome.conflict
            ? t("build.deleteChanged")
            : outcome.refusals.map((refusal) => refusal.message).join(" ")
      );
    } finally {
      setRemoveBusy(false);
    }
  };
  const scope = source.scopeOf?.(entry.kind);
  const scopeName = (of: BuildScope) => assetPlace(of, source.rights.workspaces, t).name;
  // "Wo" offers the places in the order of the ladder: Nur ich, the teams, Alle.
  const rung = (of: BuildScope) =>
    ({ mine: 0, workspace: 1, all: 2 })[assetPlace(of, source.rights.workspaces, t).rung];
  const scopes =
    scope && source.chooseScope
      ? buildScopes(source.rights).toSorted((one, other) => rung(one) - rung(other))
      : [];
  const filtered = settledText.trim() !== "";
  // A kind that only lists has no asset to start and no CLI entry, and a page only to show one.
  const editable = isEditableKind(entry) ? entry : undefined;
  const opens = opensAssets(entry);
  // "New" of a kind with a page opens that page empty, or the kind's own dialog. A kind without
  // one asks what the new one should do and opens the agent with it: its first save creates
  // the asset (NAV-2).
  const withAgent = state.canCreate && !editable ? BUILT_WITH_AGENT[entry.kind] : undefined;
  const startWithAgent = withAgent ? source.buildWithAgent : undefined;
  const newButton =
    withAgent && startWithAgent ? (
      <Button onClick={onNew}>
        <Plus aria-hidden="true" />
        {t(withAgent.label)}
      </Button>
    ) : editable && state.canCreate ? (
      <Button onClick={onNew}>
        <Plus aria-hidden="true" />
        {t(editable.newLabel)}
      </Button>
    ) : undefined;
  const listError = list.error ? <LoadError message={list.error} onRetry={list.retry} /> : null;
  // Where the empty list offers the agent, the head's New would be a second button for the same
  // call: the head drops it once the list has answered with none and no search narrows it.
  // While it loads, New stands, so making one never waits for the list. A kind that offers the
  // agent adds no rows of its own (`ListLead`).
  const offerStands =
    entry.emptyBuild && startWithAgent && !list.error && !filtered && list.rows?.length === 0;
  const headNew = offerStands ? undefined : newButton;

  // The rows a kind adds come first, in the same list, under the same search and filters.
  const listBody = (lead: BuildListLead) => {
    const leadRows = lead.rows;
    // Where the assets could not be read, the kind's own rows still show under the list's error.
    const rows = list.rows ?? (listError && leadRows?.length ? [] : undefined);
    return (
      <>
        {listError}
        {lead.error}
        {removeError ? (
          <InlineError className="mb-4" data-build-row-remove-failed="">
            {removeError}
          </InlineError>
        ) : null}
        {rows === undefined || leadRows === undefined ? (
          listError ? null : (
            <SkeletonList rows={6} />
          )
        ) : rows.length === 0 && leadRows.length === 0 && !filtered && scopes.length < 2 ? (
          <BuildListEmpty kind={kind} newButton={newButton} startWithAgent={startWithAgent} />
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
                <>
                  {scope && scopes.length > 1 ? (
                    <Picker
                      label={t("build.placeFilter")}
                      options={scopes.map((option) => ({
                        value: buildScopeValue(option),
                        label: scopeName(option)
                      }))}
                      value={buildScopeValue(scope)}
                      onValueChange={(value) => {
                        const chosen = scopes.find((option) => buildScopeValue(option) === value);
                        if (chosen) source.chooseScope?.(chosen);
                      }}
                    >
                      <PickerButton
                        label={t("build.placeFilter")}
                        value={scopeName(scope)}
                        placeholder={t("build.placeAll")}
                      />
                    </Picker>
                  ) : null}
                </>
              }
            />
            {rows.length === 0 &&
            leadRows.length === 0 &&
            !filtered &&
            entry.emptyBuild &&
            startWithAgent ? (
              // An empty scope of a kind the agent builds offers it under the scope's picker.
              <BuildListEmpty kind={kind} newButton={newButton} startWithAgent={startWithAgent} />
            ) : rows.length === 0 && leadRows.length === 0 ? (
              <EmptyState layout="inline" icon={<SearchX aria-hidden="true" />}>
                {scope && !filtered
                  ? t("build.noneInPlace", { place: scopeName(scope) })
                  : t("build.noMatch", { query: settledText.trim() })}
              </EmptyState>
            ) : (
              <List aria-label={t(entry.label)}>
                {leadRows.map((row) => (
                  <ListRow
                    key={row.key}
                    leading={<RowMark entry={entry} title={row.title} />}
                    title={row.title}
                    descriptionWraps="always"
                    description={row.description}
                    chips={row.chips}
                    actions={row.actions}
                    actionsVisible
                  />
                ))}
                {rows.map((asset) => {
                  const title = asset.title.trim() || asset.name;
                  const own = entry.row?.(asset, t);
                  const rowText = entry.rowText?.(asset)?.trim();
                  const RowLine = entry.RowLine;
                  const removable = rowRemovable(asset);
                  return (
                    <ListRow
                      key={asset.name}
                      {...(removable
                        ? {
                            actions: (
                              <IconButton
                                label={
                                  isEditableKind(entry) && entry.rowRemoveLabel
                                    ? t(entry.rowRemoveLabel, { name: title })
                                    : t("configDelete")
                                }
                                size="sm"
                                variant="ghost"
                                data-build-row-remove={asset.name}
                                onClick={() => setRemoving(asset)}
                              >
                                <Trash2 aria-hidden="true" />
                              </IconButton>
                            ),
                            actionsVisible: true
                          }
                        : {})}
                      leading={own?.leading ?? <RowMark entry={entry} title={title} />}
                      title={title}
                      // A kind's own line is a sentence, read whole.
                      descriptionWraps={!own && RowLine !== undefined ? "always" : false}
                      description={
                        own ? (
                          own.description
                        ) : RowLine ? (
                          <RowLine asset={asset} />
                        ) : (
                          rowText || undefined
                        )
                      }
                      // Every row says where the asset sits, in the words of the ladder: Nur
                      // ich, the team's name or Alle, the same chip as on its page.
                      chips={
                        <>
                          <AssetPlaceLine owner={asset.scope} />
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
      </>
    );
  };

  return (
    <>
      <PageHeader
        title={t(entry.label)}
        description={entry.description ? t(entry.description) : undefined}
        primaryAction={headNew}
        secondaryActions={
          editable?.importDialog && state.canCreate
            ? [
                {
                  label: t(editable.importDialog.label),
                  icon: <FolderInput aria-hidden="true" />,
                  onSelect: onImport
                }
              ]
            : undefined
        }
        menu={
          editable && !editable.withoutCli ? (
            <DropdownMenuItem
              icon={<Terminal aria-hidden="true" />}
              onSelect={() => setCliOpen(true)}
            >
              {t("build.cliTitle")}
            </DropdownMenuItem>
          ) : undefined
        }
      />
      {loadError}
      {entry.ListLead ? (
        <entry.ListLead filter={{ text: settledText, scope }}>{listBody}</entry.ListLead>
      ) : (
        listBody(NO_LEAD)
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
      {editable ? (
        <ConfirmDialog
          open={removing !== undefined}
          title={t(editable.deleteTitle, {
            name: removing ? removing.title.trim() || removing.name : ""
          })}
          confirmLabel={t("configDelete")}
          loading={removeBusy}
          onConfirm={() => {
            if (removing) removeRow(removing).catch(() => setRemoveBusy(false));
          }}
          onClose={() => setRemoving(undefined)}
        >
          {t(editable.deleteDescription)}
        </ConfirmDialog>
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
  return (
    <span
      aria-hidden="true"
      className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground"
    >
      <RegistryIcon name={entry.icon} className="size-4" />
    </span>
  );
}
