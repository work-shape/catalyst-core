// @rights-screen: included in the rights wording guard.
import { Ban, Check, Ellipsis, Undo2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type {
  AdministeredUser,
  ConfigAssetSummary,
  CreatePermissionGrantRequest,
  LocaleCode,
  EffectivePermissions,
  PermissionGrantRow
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FormNotice,
  IconButton,
  List,
  Picker,
  PickerButton,
  RadioGroup,
  RegistryIcon,
  SkeletonList,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useDocsLinkShown
} from "@work-shape/catalyst-ui";
import { DocsReference } from "../../shared/docs-links";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import {
  accessWriteFailure,
  grantAction,
  emptyGrantForm,
  grantRequests,
  grantableUsers,
  GrantWriteError,
  groupGrants,
  isConfigAssetGrantKind,
  withGrantKind,
  type AccessWriteFailure,
  type GrantForm,
  type GrantGroup,
  type GrantKind,
  type GrantVerb,
  type GrantWriteResult,
  type LoadFailure
} from "./access-model";
import {
  kindLabelKeys,
  kindWords,
  rightAllowNoteKeys,
  rightSentenceKeys,
  scopeChoice,
  wordsOfKind
} from "./grant-words";
import { actionLabel, verbLabel } from "./right-words";

import { grantOptions, type GrantChoices } from "./grant-options";

/** From this many entries on, a picker of the grant dialog shows its search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

/**
 * The columns of the grant list once the list itself is wide enough for them. Narrower, a row
 * stacks: the person with the row's menu, then the place, then the actions and who granted
 * them. The list's own width decides, not the window's, because the settings rail and the
 * sidebar take their share of a window.
 */
const GRANT_COLUMNS = "@xl:grid-cols-[minmax(0,4fr)_minmax(0,4fr)_minmax(0,6fr)_1.75rem]";

type Translate = TranslationContextValue["t"];

export type { GrantChoices } from "./grant-options";

/** What one row says, with its effect in words: "Denied: Write agents". */
function grantLabel(grant: PermissionGrantRow, t: Translate): string {
  const action = actionLabel(grant.action, t);
  return grant.effect === "deny" ? t("access.deniedAction", { action }) : action;
}

/** The names the page was told, by id: of a workspace, and of an asset beyond agents and skills. */
interface ScopeNames {
  workspace(workspaceId: string): string | undefined;
  asset(assetId: string): string | undefined;
}

/**
 * Where a row applies, in one line. An asset is named by the title its kind's list gives it,
 * else by its name; a workspace by the name the page was told. The server leaves an asset's
 * name out for a reader who may not see it, and the row then says that much, never an id.
 */
function scopeLabel(grant: PermissionGrantRow, t: Translate, names: ScopeNames): string {
  switch (grant.scopeKind) {
    case "instance":
      return t("access.scopeWholeInstance");
    case "namespace":
      return t("access.scopeNamespace", { prefix: grant.namespace ?? "" });
    case "workspace": {
      const name = grant.scopeId === undefined ? undefined : names.workspace(grant.scopeId);
      return name === undefined
        ? t("access.scopeWorkspaceHidden")
        : t("access.scopeWorkspace", { name });
    }
    case "asset": {
      const asset = grant.scopeAsset;
      const name =
        (grant.scopeId === undefined ? undefined : names.asset(grant.scopeId)) ?? asset?.name;
      if (asset === undefined || name === undefined) {
        return t("access.scopeAssetHidden");
      }
      const words = wordsOfKind(asset.kind);
      return words ? t(words.scopeAsset, { name }) : name;
    }
  }
}

export interface GrantsTabProps {
  /** The giver's effective rights; absent while loading or after a failed read. */
  giver?: EffectivePermissions;
  /** Absent while the grants load. */
  grants: readonly PermissionGrantRow[] | undefined;
  loadFailed: boolean;
  onRetry(): void;
  /** The users the caller is shown. Absent while they load and when they could not be loaded. */
  users: readonly AdministeredUser[] | undefined;
  usersFailed: boolean;
  /** The active agents and skills. Absent while they load and when they could not be loaded. */
  assets: readonly ConfigAssetSummary[] | undefined;
  /** `forbidden` when the caller may not read the agents and skills of the instance. */
  assetsFailure: LoadFailure | undefined;
  /**
   * The assets of every further kind the instance has, such as its Connections and its
   * Workflows, by kind. A kind without an entry is not offered: the instance has no such kind
   * while its module is off. Agents and skills are always offered.
   */
  kindAssets?: Partial<Record<GrantKind, GrantChoices>>;
  /** The Shared Workspaces, for a grant on what a workspace owns and to name such a row. */
  workspaces?: GrantChoices;
  /**
   * Writes the rows that do not exist yet and says how many it added. Rejects with a
   * `GrantWriteError` that names the refused row and how many were written before it.
   */
  onGrant(requests: readonly CreatePermissionGrantRequest[]): Promise<GrantWriteResult>;
  onRevoke(grantId: string): Promise<unknown>;
}

/** The grants of the instance, one row per person and place, and the dialog that writes them. */
export function GrantsTab({
  giver,
  grants,
  loadFailed,
  onRetry,
  users,
  usersFailed,
  assets,
  assetsFailure,
  kindAssets,
  workspaces,
  onGrant,
  onRevoke
}: GrantsTabProps) {
  const { t, locale } = useTranslation();
  const [granting, setGranting] = useState(false);
  const [written, setWritten] = useState<GrantWriteResult | undefined>();
  const [pendingRevoke, setPendingRevoke] = useState<PermissionGrantRow | undefined>();
  const [revoking, setRevoking] = useState(false);
  const [revokeFailed, setRevokeFailed] = useState(false);
  const findUser = (userId: string | undefined) =>
    userId === undefined ? undefined : users?.find((user) => user.id === userId);
  const holderName = (holderId: string) =>
    findUser(holderId)?.displayLabel ?? t("access.unknownUser");
  const scopeNames: ScopeNames = {
    workspace: (workspaceId) =>
      workspaces?.items?.find((workspace) => workspace.id === workspaceId)?.name,
    asset: (assetId) =>
      Object.values(kindAssets ?? {})
        .flatMap((choices) => choices.items ?? [])
        .find((asset) => asset.id === assetId)?.name
  };

  const choiceAssets: Partial<Record<GrantKind, GrantChoices>> = {
    ...Object.fromEntries(
      (["agent", "skill"] as const).map((kind) => [
        kind,
        {
          items: assets?.flatMap((asset) =>
            asset.kind === kind && asset.id !== undefined
              ? [
                  {
                    id: asset.id,
                    name: asset.name,
                    resource: { kind, name: asset.name, assetId: asset.id }
                  }
                ]
              : []
          ),
          failed: assetsFailure !== undefined
        }
      ])
    ),
    ...kindAssets
  };
  const options = grantOptions(giver, choiceAssets, workspaces);
  const newGrant = (
    <Button size="sm" disabled={options.kinds.length === 0} onClick={() => setGranting(true)}>
      {t("access.newGrant")}
    </Button>
  );

  return (
    <div className="grid gap-4">
      {revokeFailed ? (
        <Banner tone="danger" onDismiss={() => setRevokeFailed(false)}>
          {t("access.revokeFailed")}
        </Banner>
      ) : null}
      {/* Rows that existed already were left alone: the person is told what was added. */}
      {written !== undefined && written.existing > 0 ? (
        <Banner onDismiss={() => setWritten(undefined)}>
          {t(written.added === 0 ? "access.grantNothingAdded" : "access.grantPartlyAdded", {
            added: written.added,
            existing: written.existing
          })}
        </Banner>
      ) : null}
      {loadFailed ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("tryAgain")}
            </Button>
          }
        >
          {t("access.grantsLoadFailed")}
        </Banner>
      ) : grants === undefined ? (
        <SkeletonList rows={4} />
      ) : grants.length === 0 ? (
        <EmptyState action={newGrant}>{t("access.grantsEmpty")}</EmptyState>
      ) : (
        <>
          <div className="flex justify-end">{newGrant}</div>
          <div className="@container">
            <div
              aria-hidden="true"
              className={`hidden gap-x-4 border-b px-3 pb-2 text-caption font-medium text-muted-foreground @xl:grid ${GRANT_COLUMNS}`}
            >
              <span>{t("access.grantHolder")}</span>
              <span>{t("access.grantScope")}</span>
              <span>{t("access.grantActions")}</span>
            </div>
            <List className="gap-0">
              {groupGrants(grants, holderName).map((group) => (
                <GrantGroupRow
                  key={group.key}
                  group={group}
                  holder={findUser(group.holderId)}
                  holderName={holderName(group.holderId)}
                  grantedBy={grantedByText(group, findUser, t)}
                  grantedAt={formatDate(latest(group), locale)}
                  where={scopeLabel(group.scope, t, scopeNames)}
                  onRevoke={setPendingRevoke}
                />
              ))}
            </List>
          </div>
        </>
      )}
      {granting ? (
        <GrantDialog
          users={users}
          usersFailed={usersFailed}
          assets={assets}
          assetsFailure={assetsFailure}
          kindAssets={choiceAssets}
          options={options}
          workspaces={workspaces}
          onGrant={(requests) =>
            onGrant(requests).then((result) => {
              setWritten(result);
              return result;
            })
          }
          onClose={() => setGranting(false)}
        />
      ) : null}
      {pendingRevoke ? (
        <ConfirmDialog
          open
          title={t(
            pendingRevoke.effect === "deny" ? "access.revokeDenyTitle" : "access.revokeTitle"
          )}
          confirmLabel={t(pendingRevoke.effect === "deny" ? "access.revokeDeny" : "access.revoke")}
          loading={revoking}
          onConfirm={() => {
            setRevoking(true);
            setRevokeFailed(false);
            onRevoke(pendingRevoke.id)
              .catch(() => setRevokeFailed(true))
              .finally(() => {
                setRevoking(false);
                setPendingRevoke(undefined);
              });
          }}
          onClose={() => setPendingRevoke(undefined)}
        >
          {t(
            pendingRevoke.effect === "deny"
              ? "access.revokeDenyDescription"
              : "access.revokeAllowDescription",
            {
              name: holderName(pendingRevoke.holderId),
              action: actionLabel(pendingRevoke.action, t),
              scope: scopeLabel(pendingRevoke, t, scopeNames)
            }
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The newest row of a group: when the person last got something there. */
function latest(group: GrantGroup): string {
  return group.grants.reduce(
    (newest, grant) => (grant.createdAt > newest ? grant.createdAt : newest),
    group.scope.createdAt
  );
}

/**
 * Who wrote the rows of a group. The server leaves out a writer the reader is not shown: that
 * is no error, and the cell says so in words instead of staying empty.
 */
function grantedByText(
  group: GrantGroup,
  findUser: (userId: string | undefined) => AdministeredUser | undefined,
  t: Translate
): string {
  const names = group.grants.map(
    (grant) => findUser(grant.grantedBy)?.displayLabel ?? t("access.notAvailable")
  );
  return [...new Set(names)].join(", ");
}

/** One person's rows on one place: the actions as chips, each revoked from the row's menu. */
function GrantGroupRow({
  group,
  holder,
  holderName,
  grantedBy,
  grantedAt,
  where,
  onRevoke
}: {
  group: GrantGroup;
  holder: AdministeredUser | undefined;
  holderName: string;
  grantedBy: string;
  grantedAt: string;
  /** Where the rows apply, in one line. */
  where: string;
  onRevoke(grant: PermissionGrantRow): void;
}) {
  const { t } = useTranslation();
  const assetGone = group.scope.scopeAsset?.active === false;
  return (
    <li
      data-testid="grant-row"
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 border-b px-3 py-3 last:border-0 ${GRANT_COLUMNS}`}
    >
      <div className="grid min-w-0">
        <span className="truncate">{holderName}</span>
        {holder?.email ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A long address is cut; the whole of it shows on hover and on focus. */}
              <span
                tabIndex={0}
                className="truncate rounded-sm text-caption text-muted-foreground focus-visible:focus-ring"
              >
                {holder.email}
              </span>
            </TooltipTrigger>
            <TooltipContent>{holder.email}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="@xl:order-last">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" label={t("access.grantMenu", { name: holderName })}>
              <Ellipsis aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {group.grants.map((grant) => (
              <DropdownMenuItem
                key={grant.id}
                tone="danger"
                icon={<Undo2 aria-hidden="true" />}
                onSelect={() => onRevoke(grant)}
              >
                {t(grant.effect === "deny" ? "access.revokeDenyItem" : "access.revokeAllowItem", {
                  action: actionLabel(grant.action, t)
                })}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="col-span-2 grid min-w-0 justify-items-start gap-1 @xl:col-span-1">
        <span className="max-w-full break-words">{where}</span>
        {assetGone ? (
          <>
            <Badge tone="warning" size="sm">
              {t("access.scopeAssetGone")}
            </Badge>
            <span className="text-caption text-muted-foreground">
              {t("access.scopeAssetGoneHint")}
            </span>
          </>
        ) : null}
      </div>
      <div className="col-span-2 grid min-w-0 gap-1.5 @xl:col-span-1">
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          {group.grants.map((grant) => (
            <li key={grant.id} className="max-w-full">
              {/* A deny differs by its icon, its outline and its word, not by colour alone. */}
              <Badge
                data-effect={grant.effect}
                tone={grant.effect === "deny" ? "danger" : "success"}
                appearance={grant.effect === "deny" ? "outline" : "soft"}
              >
                {grant.effect === "deny" ? (
                  <Ban aria-hidden="true" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                {grantLabel(grant, t)}
              </Badge>
            </li>
          ))}
        </ul>
        <span className="text-caption text-muted-foreground">
          {t("access.grantedByLine", { name: grantedBy, date: grantedAt })}
        </span>
      </div>
    </li>
  );
}

function formatDate(value: string, locale: LocaleCode): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

const failureKeys: Partial<Record<AccessWriteFailure, TranslationKey>> = {
  userBeingDeleted: "access.grantUserBeingDeleted",
  unknownHolder: "access.grantUnknownHolder",
  assetGone: "access.grantAssetGone",
  rightNotOffered: "access.grantRightNotOffered",
  moduleOff: "access.grantModuleOff",
  missingManageRight: "access.grantMissingManageRight",
  holderIsSuperadmin: "access.grantHolderIsSuperadmin"
};

/** The sentence for a grant that stopped at one row, with how many rows were written before. */
function grantFailureText(error: unknown, t: Translate): string {
  const cause = error instanceof GrantWriteError ? error.cause : error;
  const failure = accessWriteFailure(cause);
  const sentence = t(failureKeys[failure] ?? "access.grantFailed");
  return error instanceof GrantWriteError && error.written > 0
    ? `${sentence} ${t("access.grantPartlyWritten", { written: error.written, total: error.total })}`
    : sentence;
}

function GrantDialog({
  users,
  usersFailed,
  assets,
  assetsFailure,
  kindAssets,
  options,
  workspaces,
  onGrant,
  onClose
}: Pick<
  GrantsTabProps,
  "users" | "usersFailed" | "assets" | "assetsFailure" | "kindAssets" | "workspaces" | "onGrant"
> & { options: ReturnType<typeof grantOptions>; onClose(): void }) {
  const { t } = useTranslation();
  const docsLinkShown = useDocsLinkShown();
  const formId = useId();
  const [form, setForm] = useState<GrantForm>(emptyGrantForm);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const change = (patch: Partial<GrantForm>) => setForm((current) => ({ ...current, ...patch }));

  const holders = grantableUsers(users ?? []);
  const holder = holders.find((user) => user.id === form.holderId);
  const kinds = options.kinds;
  const kind = kinds.includes(form.kind) ? form.kind : (kinds[0] ?? form.kind);
  const requestedVerbs = form.verbs.filter((verb) => options.places(kind, [verb]).length > 0);
  const scopeKinds = options.places(kind, requestedVerbs);
  const scopeKind = scopeKinds.find((scope) => scope === form.scopeKind) ?? scopeKinds[0];
  const allowedWorkspaces = options.choices(kind, "workspace", requestedVerbs);
  const words = kindWords[kind];
  // What the asset picker chooses from: the agents or skills, or the assets of a further kind.
  const choices: GrantChoices =
    kindAssets?.[kind] ??
    (isConfigAssetGrantKind(kind)
      ? {
          items: assets?.flatMap((candidate) =>
            candidate.kind === kind && candidate.id !== undefined
              ? [{ id: candidate.id, name: candidate.name }]
              : []
          ),
          failed: assetsFailure !== undefined
        }
      : { items: undefined, failed: false });
  const kindItems = options.choices(kind, "asset", requestedVerbs);
  const assetsError = !choices.failed
    ? undefined
    : t(
        isConfigAssetGrantKind(kind) && assetsFailure === "forbidden"
          ? "access.referencesForbidden"
          : words.assetsLoadFailed
      );
  const asset = kindItems.find((candidate) => candidate.id === form.assetId);
  const kindIcon = <RegistryIcon name={kind} className="size-4 text-muted-foreground" />;
  /** The sentence under a right, with what else the right needs where an allow alone does nothing. */
  const rightDescription = (verb: GrantVerb): string | undefined => {
    const action = grantAction(kind, verb);
    const sentence = action && rightSentenceKeys[action];
    const note = action && form.effect === "allow" ? rightAllowNoteKeys[action] : undefined;
    const parts = [sentence, note].flatMap((key) => (key === undefined ? [] : [t(key)]));
    return parts.length === 0 ? undefined : parts.join(" ");
  };
  const workspace = allowedWorkspaces.find((candidate) => candidate.id === form.workspaceId);
  // With one place to choose there is nothing to ask: the step is left out.
  const verbs = options.verbs(
    kind,
    scopeKind,
    scopeKind === "workspace" ? workspace?.id : asset?.id
  );
  const selectedVerbs = requestedVerbs.filter((verb) => verbs.includes(verb));
  const requests = grantRequests({
    ...form,
    kind,
    scopeKind,
    verbs: selectedVerbs,
    assetId: asset?.id,
    workspaceId: workspace?.id
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFailure(undefined);
    if (!requests) {
      return;
    }
    setSaving(true);
    onGrant(requests)
      .then(onClose)
      .catch((error: unknown) => setFailure(grantFailureText(error, t)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={t("access.grantDialogTitle")}
      description={t("access.grantDialogDescription")}
      footer={
        <>
          {failure !== undefined || (submitted && !requests) ? (
            <FormNotice tone="error" className="mr-auto">
              {failure ?? t("access.grantIncomplete")}
            </FormNotice>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {t("access.submitGrant")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        <Field
          label={t("access.grantHolder")}
          required
          error={usersFailed ? t("access.usersLoadFailed") : undefined}
        >
          <Picker
            search={holders.length >= PICKER_SEARCH_FROM_COUNT}
            options={holders.map((user) => ({
              value: user.id,
              label: user.displayLabel,
              description: user.email
            }))}
            value={form.holderId}
            onValueChange={(holderId) => change({ holderId })}
          >
            <PickerButton
              label={t("access.grantHolder")}
              placeholder={t("access.choosePerson")}
              value={holder?.displayLabel}
              disabled={users === undefined}
            />
          </Picker>
        </Field>
        <RadioGroup
          variant="plain"
          label={t("access.grantKind")}
          options={kinds.map((kind) => ({
            value: kind,
            label: t(kindLabelKeys[kind])
          }))}
          value={kind}
          // An asset belongs to its kind, and a kind has its own actions and places.
          onValueChange={(kind) => setForm((current) => withGrantKind(current, kind))}
        />
        <fieldset className="grid gap-2.5">
          <legend className="mb-2.5 text-label">{t("access.grantActions")}</legend>
          {verbs.map((verb) => (
            <Checkbox
              key={verb}
              label={
                verb === "read_run_data"
                  ? actionLabel("workflow.read_run_data", t)
                  : verbLabel(verb, t)
              }
              description={rightDescription(verb)}
              checked={selectedVerbs.includes(verb)}
              onCheckedChange={(checked) =>
                change({
                  verbs: checked
                    ? [...selectedVerbs, verb]
                    : selectedVerbs.filter((other) => other !== verb)
                })
              }
            />
          ))}
        </fieldset>
        {scopeKinds.length > 1 ? (
          <RadioGroup
            label={t("access.grantScopeKind")}
            options={scopeKinds.map((scopeKind) => {
              const keys = scopeChoice(scopeKind, kind);
              return { value: scopeKind, label: t(keys.label), description: t(keys.description) };
            })}
            value={scopeKind}
            onValueChange={(scopeKind) => change({ scopeKind })}
            hint={docsLinkShown ? <DocsReference to="rightPlace" /> : undefined}
          />
        ) : null}
        {scopeKind === "workspace" ? (
          <Field
            label={t("access.grantWorkspace")}
            required
            error={workspaces?.failed ? t("access.workspacesLoadFailed") : undefined}
            hint={allowedWorkspaces.length === 0 ? t("access.noWorkspaces") : undefined}
          >
            <Picker
              search={allowedWorkspaces.length >= PICKER_SEARCH_FROM_COUNT}
              options={allowedWorkspaces.map((candidate) => ({
                value: candidate.id,
                label: candidate.name
              }))}
              value={form.workspaceId}
              onValueChange={(workspaceId) => change({ workspaceId })}
            >
              <PickerButton
                label={t("access.grantWorkspace")}
                placeholder={t("access.chooseWorkspace")}
                value={workspace?.name}
                disabled={allowedWorkspaces.length === 0}
              />
            </Picker>
          </Field>
        ) : scopeKind === "asset" ? (
          <Field
            label={t(words.assetField)}
            required
            error={assetsError}
            hint={choices.items?.length === 0 ? t(words.noAssets) : undefined}
          >
            <Picker
              search={kindItems.length >= PICKER_SEARCH_FROM_COUNT}
              // What an asset says of itself is what tells two of them apart: shown in full.
              wrapDescriptions
              options={kindItems.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
                leading: kindIcon,
                ...(candidate.description ? { description: candidate.description } : {})
              }))}
              value={form.assetId}
              onValueChange={(assetId) => change({ assetId })}
            >
              <PickerButton
                label={t(words.assetField)}
                placeholder={t(words.chooseAsset)}
                value={asset?.name}
                leading={asset ? kindIcon : undefined}
                disabled={kindItems.length === 0}
              />
            </Picker>
          </Field>
        ) : null}
        <RadioGroup
          label={t("access.grantEffect")}
          options={[
            {
              value: "allow",
              label: t("access.effectAllow"),
              description: t("access.effectAllowDescription")
            },
            {
              value: "deny",
              label: t("access.effectDeny"),
              description: (
                <>
                  {t("access.effectDenyDescription")} <DocsReference to="rightDenied" />
                </>
              )
            }
          ]}
          value={form.effect}
          onValueChange={(effect) => change({ effect })}
        />
      </form>
    </Dialog>
  );
}
