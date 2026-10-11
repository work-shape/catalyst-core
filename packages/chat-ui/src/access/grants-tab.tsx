import { Ban, Check, Ellipsis, Undo2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type {
  AdministeredUser,
  ConfigAssetSummary,
  CreatePermissionGrantRequest,
  LocaleCode,
  NamespaceWithUsage,
  PermissionGrantRow
} from "@vivd-catalyst/api-client";
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
  SkeletonList,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useDocsLinkShown
} from "@vivd-catalyst/ui";
import { DocsReference } from "../docs-links";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "../i18n";
import {
  GRANT_KINDS,
  accessWriteFailure,
  emptyGrantForm,
  grantRequests,
  grantScopeKinds,
  grantVerbs,
  grantableUsers,
  GrantWriteError,
  groupGrants,
  splitGrantableAction,
  withGrantKind,
  type AccessWriteFailure,
  type GrantForm,
  type GrantGroup,
  type GrantKind,
  type GrantScopeKind,
  type GrantVerb,
  type GrantWriteResult,
  type LoadFailure
} from "./access-model";

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

export const verbLabelKeys: Record<GrantVerb, TranslationKey> = {
  read: "access.actionRead",
  use: "access.actionUse",
  write: "access.actionWrite",
  delete: "access.actionDelete"
};

export const kindLabelKeys: Record<GrantKind, TranslationKey> = {
  agent: "access.kindAgent",
  skill: "access.kindSkill",
  connection: "access.kindConnection"
};

const actionOnKindKeys: Record<GrantKind, TranslationKey> = {
  agent: "access.actionOnAgent",
  skill: "access.actionOnSkill",
  connection: "access.actionOnConnection"
};

/** What an action of a Connection allows, as the dialog says it under the action. */
const connectionVerbDescriptionKeys: Partial<Record<GrantVerb, TranslationKey>> = {
  read: "access.actionReadConnectionDescription",
  use: "access.actionUseConnectionDescription"
};

/** The places a grant applies at, as the dialog offers them for one kind. */
const scopeChoiceKeys: Record<
  GrantScopeKind,
  (kind: GrantKind) => { label: TranslationKey; description: TranslationKey }
> = {
  namespace: (kind) => ({
    label: "access.scopeInNamespace",
    description:
      kind === "connection"
        ? "access.scopeInNamespaceConnectionDescription"
        : "access.scopeInNamespaceDescription"
  }),
  asset: (kind) =>
    kind === "connection"
      ? { label: "access.scopeOnConnection", description: "access.scopeOnConnectionDescription" }
      : { label: "access.scopeOnAsset", description: "access.scopeOnAssetDescription" },
  workspace: () => ({
    label: "access.scopeInWorkspace",
    description: "access.scopeInWorkspaceDescription"
  })
};

/** What a picker of the grant dialog chooses from, such as the Connections of the instance. */
interface GrantChoices {
  /** Absent while the choices load and when they could not be loaded. */
  items: readonly { id: string; name: string; description?: string }[] | undefined;
  failed: boolean;
}

/** "Write agents" for an action of this page; the action's own name for any other. */
function actionLabel(action: string, t: Translate): string {
  const parts = splitGrantableAction(action);
  if (!parts) {
    return action;
  }
  return t(actionOnKindKeys[parts.kind], { action: t(verbLabelKeys[parts.verb]) });
}

/** What one row says, with its effect in words: "Denied: Write agents". */
function grantLabel(grant: PermissionGrantRow, t: Translate): string {
  const action = actionLabel(grant.action, t);
  return grant.effect === "deny" ? t("access.deniedAction", { action }) : action;
}

/**
 * Where a row applies, in one line. The server leaves an asset's name out for a reader who
 * may not read agents and skills; the row then names the asset by its id. A workspace is named
 * when the page was told its name, else by its id.
 */
function scopeLabel(
  grant: PermissionGrantRow,
  t: Translate,
  workspaceName: (workspaceId: string) => string | undefined
): string {
  if (grant.scopeKind === "namespace" && grant.namespace !== undefined) {
    return t("access.scopeNamespace", { prefix: grant.namespace });
  }
  if (grant.scopeKind === "workspace" && grant.scopeId !== undefined) {
    return t("access.scopeWorkspace", {
      name: workspaceName(grant.scopeId) ?? grant.scopeId
    });
  }
  if (grant.scopeKind !== "asset") {
    return grant.scopeKind;
  }
  const asset = grant.scopeAsset;
  if (asset?.name === undefined) {
    return t("access.scopeAssetById", { id: grant.scopeId ?? "" });
  }
  return asset.kind === "agent"
    ? t("access.scopeAgent", { name: asset.name })
    : asset.kind === "skill"
      ? t("access.scopeSkill", { name: asset.name })
      : asset.kind === "connection"
        ? t("access.scopeConnection", { name: asset.name })
        : asset.name;
}

export interface GrantsTabProps {
  /** Absent while the grants load. */
  grants: readonly PermissionGrantRow[] | undefined;
  loadFailed: boolean;
  onRetry(): void;
  /** The users the caller is shown. Absent while they load and when they could not be loaded. */
  users: readonly AdministeredUser[] | undefined;
  usersFailed: boolean;
  namespaces: readonly NamespaceWithUsage[] | undefined;
  /** The active agents and skills. Absent while they load and when they could not be loaded. */
  assets: readonly ConfigAssetSummary[] | undefined;
  /** `forbidden` when the caller may not read the agents and skills of the instance. */
  assetsFailure: LoadFailure | undefined;
  /**
   * The Connections of the instance. Absent while the instance has no Connections: the dialog
   * then offers agents and skills only.
   */
  connections?: GrantChoices;
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
  grants,
  loadFailed,
  onRetry,
  users,
  usersFailed,
  namespaces,
  assets,
  assetsFailure,
  connections,
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
  const workspaceName = (workspaceId: string) =>
    workspaces?.items?.find((workspace) => workspace.id === workspaceId)?.name;

  const newGrant = (
    <Button size="sm" onClick={() => setGranting(true)}>
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
                  scope={scopeLabel(group.scope, t, workspaceName)}
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
          namespaces={namespaces}
          assets={assets}
          assetsFailure={assetsFailure}
          connections={connections}
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
              scope: scopeLabel(pendingRevoke, t, workspaceName)
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
  scope,
  onRevoke
}: {
  group: GrantGroup;
  holder: AdministeredUser | undefined;
  holderName: string;
  grantedBy: string;
  grantedAt: string;
  /** Where the rows apply, in one line. */
  scope: string;
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
        <span className="max-w-full break-words">{scope}</span>
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
  unknownNamespace: "access.grantUnknownNamespace",
  assetGone: "access.grantAssetGone"
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
  namespaces,
  assets,
  assetsFailure,
  connections,
  workspaces,
  onGrant,
  onClose
}: Pick<
  GrantsTabProps,
  | "users"
  | "usersFailed"
  | "namespaces"
  | "assets"
  | "assetsFailure"
  | "connections"
  | "workspaces"
  | "onGrant"
> & { onClose(): void }) {
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
  // A Connection is offered while the instance has Connections at all.
  const kinds = GRANT_KINDS.filter((kind) => kind !== "connection" || connections !== undefined);
  const ofConnection = form.kind === "connection";
  // What the asset picker chooses from: the Connections, or the agents or skills.
  const kindAssets = ofConnection
    ? (connections?.items ?? [])
    : (assets ?? []).flatMap((candidate) =>
        candidate.kind === form.kind && candidate.id !== undefined
          ? [{ id: candidate.id, name: candidate.name }]
          : []
      );
  const assetsLoaded = ofConnection ? connections?.items !== undefined : assets !== undefined;
  const assetsError = ofConnection
    ? connections?.failed
      ? t("access.connectionsLoadFailed")
      : undefined
    : assetsFailure === undefined
      ? undefined
      : t(
          assetsFailure === "forbidden"
            ? "access.referencesForbidden"
            : "access.referencesLoadFailed"
        );
  const asset = kindAssets.find((candidate) => candidate.id === form.assetId);
  const verbDescription = (verb: GrantVerb): string | undefined => {
    const key = ofConnection ? connectionVerbDescriptionKeys[verb] : undefined;
    return key === undefined ? undefined : t(key);
  };
  const workspace = workspaces?.items?.find((candidate) => candidate.id === form.workspaceId);
  const requests = grantRequests(form);

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
          value={form.kind}
          // An asset belongs to its kind, and a kind has its own actions and places.
          onValueChange={(kind) => setForm((current) => withGrantKind(current, kind))}
        />
        <fieldset className="grid gap-2.5">
          <legend className="mb-2.5 text-label">{t("access.grantActions")}</legend>
          {grantVerbs(form.kind).map((verb) => (
            <Checkbox
              key={verb}
              label={t(verbLabelKeys[verb])}
              description={verbDescription(verb)}
              checked={form.verbs.includes(verb)}
              onCheckedChange={(checked) =>
                change({
                  verbs: checked
                    ? [...form.verbs, verb]
                    : form.verbs.filter((other) => other !== verb)
                })
              }
            />
          ))}
        </fieldset>
        <RadioGroup
          label={t("access.grantScopeKind")}
          options={grantScopeKinds(form.kind).map((scopeKind) => {
            const keys = scopeChoiceKeys[scopeKind](form.kind);
            return { value: scopeKind, label: t(keys.label), description: t(keys.description) };
          })}
          value={form.scopeKind}
          onValueChange={(scopeKind) => change({ scopeKind })}
          hint={docsLinkShown ? <DocsReference to="rightPlace" /> : undefined}
        />
        {form.scopeKind === "namespace" ? (
          <Field
            label={t("access.grantNamespace")}
            required
            hint={namespaces?.length === 0 ? t("access.noNamespaces") : undefined}
          >
            <Picker
              search={(namespaces?.length ?? 0) >= PICKER_SEARCH_FROM_COUNT}
              options={(namespaces ?? []).map((namespace) => ({
                value: namespace.prefix,
                label: namespace.prefix,
                description: namespace.displayName
              }))}
              value={form.namespace}
              onValueChange={(namespace) => change({ namespace })}
            >
              <PickerButton
                label={t("access.grantNamespace")}
                placeholder={t("access.chooseNamespace")}
                value={form.namespace}
                disabled={namespaces === undefined || namespaces.length === 0}
              />
            </Picker>
          </Field>
        ) : form.scopeKind === "workspace" ? (
          <Field
            label={t("access.grantWorkspace")}
            required
            error={workspaces?.failed ? t("access.workspacesLoadFailed") : undefined}
            hint={workspaces?.items?.length === 0 ? t("access.noWorkspaces") : undefined}
          >
            <Picker
              search={(workspaces?.items?.length ?? 0) >= PICKER_SEARCH_FROM_COUNT}
              options={(workspaces?.items ?? []).map((candidate) => ({
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
                disabled={!workspaces?.items || workspaces.items.length === 0}
              />
            </Picker>
          </Field>
        ) : (
          <Field
            label={t(ofConnection ? "access.grantConnection" : "access.grantAsset")}
            required
            error={assetsError}
            hint={
              ofConnection && connections?.items?.length === 0
                ? t("access.noConnections")
                : undefined
            }
          >
            <Picker
              search={kindAssets.length >= PICKER_SEARCH_FROM_COUNT}
              options={kindAssets.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
                ...("description" in candidate && candidate.description
                  ? { description: candidate.description }
                  : {})
              }))}
              value={form.assetId}
              onValueChange={(assetId) => change({ assetId })}
            >
              <PickerButton
                label={t(ofConnection ? "access.grantConnection" : "access.grantAsset")}
                placeholder={t(ofConnection ? "access.chooseConnection" : "access.chooseAsset")}
                value={asset?.name}
                disabled={!assetsLoaded || (ofConnection && kindAssets.length === 0)}
              />
            </Picker>
          </Field>
        )}
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
