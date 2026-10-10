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
  TooltipTrigger
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationContextValue, type TranslationKey } from "../i18n";
import {
  ACCESS_ASSET_KINDS,
  ACCESS_VERBS,
  accessWriteFailure,
  emptyGrantForm,
  grantRequests,
  grantableUsers,
  GrantWriteError,
  groupGrants,
  splitGrantableAction,
  type AccessAssetKind,
  type AccessVerb,
  type AccessWriteFailure,
  type GrantForm,
  type GrantGroup,
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

export const verbLabelKeys: Record<AccessVerb, TranslationKey> = {
  read: "access.actionRead",
  write: "access.actionWrite",
  delete: "access.actionDelete"
};

export const kindLabelKeys: Record<AccessAssetKind, TranslationKey> = {
  agent: "access.kindAgent",
  skill: "access.kindSkill"
};

/** "Write agents" for an action of this page; the action's own name for any other. */
function actionLabel(action: string, t: Translate): string {
  const parts = splitGrantableAction(action);
  if (!parts) {
    return action;
  }
  return t(parts.kind === "agent" ? "access.actionOnAgent" : "access.actionOnSkill", {
    action: t(verbLabelKeys[parts.verb])
  });
}

/** What one row says, with its effect in words: "Denied: Write agents". */
function grantLabel(grant: PermissionGrantRow, t: Translate): string {
  const action = actionLabel(grant.action, t);
  return grant.effect === "deny" ? t("access.deniedAction", { action }) : action;
}

/**
 * Where a row applies, in one line. The server leaves an asset's name out for a reader who
 * may not read agents and skills; the row then names the asset by its id.
 */
function scopeLabel(grant: PermissionGrantRow, t: Translate): string {
  if (grant.scopeKind === "namespace" && grant.namespace !== undefined) {
    return t("access.scopeNamespace", { prefix: grant.namespace });
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
              scope: scopeLabel(pendingRevoke, t)
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
  onRevoke
}: {
  group: GrantGroup;
  holder: AdministeredUser | undefined;
  holderName: string;
  grantedBy: string;
  grantedAt: string;
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
        <span className="max-w-full break-words">{scopeLabel(group.scope, t)}</span>
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
  onGrant,
  onClose
}: Pick<
  GrantsTabProps,
  "users" | "usersFailed" | "namespaces" | "assets" | "assetsFailure" | "onGrant"
> & { onClose(): void }) {
  const { t } = useTranslation();
  const formId = useId();
  const [form, setForm] = useState<GrantForm>(emptyGrantForm);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const change = (patch: Partial<GrantForm>) => setForm((current) => ({ ...current, ...patch }));

  const holders = grantableUsers(users ?? []);
  const holder = holders.find((user) => user.id === form.holderId);
  const kindAssets = (assets ?? []).filter(
    (asset) => asset.kind === form.kind && asset.id !== undefined
  );
  const asset = kindAssets.find((candidate) => candidate.id === form.assetId);
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
          options={ACCESS_ASSET_KINDS.map((kind) => ({
            value: kind,
            label: t(kindLabelKeys[kind])
          }))}
          value={form.kind}
          // An asset belongs to its kind: another kind starts without one.
          onValueChange={(kind) => change({ kind, assetId: undefined })}
        />
        <fieldset className="grid gap-2.5">
          <legend className="mb-2.5 text-label">{t("access.grantActions")}</legend>
          {ACCESS_VERBS.map((verb) => (
            <Checkbox
              key={verb}
              label={t(verbLabelKeys[verb])}
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
          options={[
            {
              value: "namespace",
              label: t("access.scopeInNamespace"),
              description: t("access.scopeInNamespaceDescription")
            },
            {
              value: "asset",
              label: t("access.scopeOnAsset"),
              description: t("access.scopeOnAssetDescription")
            }
          ]}
          value={form.scopeKind}
          onValueChange={(scopeKind) => change({ scopeKind })}
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
        ) : (
          <Field
            label={t("access.grantAsset")}
            required
            error={
              assetsFailure === undefined
                ? undefined
                : t(
                    assetsFailure === "forbidden"
                      ? "access.referencesForbidden"
                      : "access.referencesLoadFailed"
                  )
            }
          >
            <Picker
              search={kindAssets.length >= PICKER_SEARCH_FROM_COUNT}
              options={kindAssets.map((candidate) => ({
                value: candidate.id ?? candidate.name,
                label: candidate.name
              }))}
              value={form.assetId}
              onValueChange={(assetId) => change({ assetId })}
            >
              <PickerButton
                label={t("access.grantAsset")}
                placeholder={t("access.chooseAsset")}
                value={asset?.name}
                disabled={assets === undefined}
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
              description: t("access.effectDenyDescription")
            }
          ]}
          value={form.effect}
          onValueChange={(effect) => change({ effect })}
        />
      </form>
    </Dialog>
  );
}
