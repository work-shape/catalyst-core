import { Ellipsis, Undo2 } from "lucide-react";
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
  Picker,
  PickerButton,
  RadioGroup,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
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
  splitGrantableAction,
  type AccessAssetKind,
  type AccessVerb,
  type AccessWriteFailure,
  type GrantForm
} from "./access-model";

/** From this many entries on, a picker of the grant dialog shows its search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

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

/** "Agent kai-helper" for an asset of a kind this page knows. */
function assetLabel(asset: { kind: string; name: string }, t: Translate): string {
  return asset.kind === "agent"
    ? t("access.scopeAgent", { name: asset.name })
    : asset.kind === "skill"
      ? t("access.scopeSkill", { name: asset.name })
      : asset.name;
}

/** Where a row applies, in one line. */
function scopeLabel(grant: PermissionGrantRow, t: Translate): string {
  if (grant.scopeKind === "namespace" && grant.namespace !== undefined) {
    return t("access.scopeNamespace", { prefix: grant.namespace });
  }
  if (grant.scopeKind === "asset") {
    return grant.scopeAsset ? assetLabel(grant.scopeAsset, t) : t("access.scopeAssetUnknown");
  }
  return grant.scopeKind;
}

/**
 * The rows of one person together, and under a person the rows of one place together, in the
 * order the actions are listed everywhere else.
 */
function inListOrder(
  grants: readonly PermissionGrantRow[],
  holderName: (grant: PermissionGrantRow) => string
): PermissionGrantRow[] {
  const place = (grant: PermissionGrantRow) =>
    `${grant.scopeKind} ${grant.namespace ?? grant.scopeAsset?.name ?? grant.scopeId ?? ""}`;
  const kind = (grant: PermissionGrantRow) =>
    splitGrantableAction(grant.action)?.kind ?? grant.action;
  const actionIndex = (grant: PermissionGrantRow) => {
    const parts = splitGrantableAction(grant.action);
    return parts ? ACCESS_VERBS.indexOf(parts.verb) : ACCESS_VERBS.length;
  };
  return [...grants].sort(
    (left, right) =>
      holderName(left).localeCompare(holderName(right)) ||
      place(left).localeCompare(place(right)) ||
      kind(left).localeCompare(kind(right)) ||
      actionIndex(left) - actionIndex(right)
  );
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
  assetsFailed: boolean;
  /** Rejects with a `GrantWriteError` that names the refused row and how many were written. */
  onGrant(requests: readonly CreatePermissionGrantRequest[]): Promise<unknown>;
  onRevoke(grantId: string): Promise<unknown>;
}

/** The grant rows of the instance, the dialog that writes rows and the revoke of one row. */
export function GrantsTab({
  grants,
  loadFailed,
  onRetry,
  users,
  usersFailed,
  namespaces,
  assets,
  assetsFailed,
  onGrant,
  onRevoke
}: GrantsTabProps) {
  const { t, locale } = useTranslation();
  const [granting, setGranting] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<PermissionGrantRow | undefined>();
  const [revoking, setRevoking] = useState(false);
  const [revokeFailed, setRevokeFailed] = useState(false);
  const userName = (userId: string | undefined) =>
    userId === undefined ? undefined : users?.find((user) => user.id === userId);
  const holderName = (grant: PermissionGrantRow) =>
    userName(grant.holderId)?.displayLabel ?? t("access.unknownUser");

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("access.grantHolder")}</TableHead>
                <TableHead>{t("access.grantAction")}</TableHead>
                <TableHead>{t("access.grantScope")}</TableHead>
                <TableHead>{t("access.grantEffect")}</TableHead>
                <TableHead>{t("access.grantedBy")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("access.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inListOrder(grants, holderName).map((grant) => {
                const holder = userName(grant.holderId);
                const grantedBy = userName(grant.grantedBy);
                const assetGone = grant.scopeAsset?.active === false;
                return (
                  <TableRow key={grant.id} data-testid="grant-row">
                    <TableCell>
                      <div className="grid">
                        <span>{holder?.displayLabel ?? t("access.unknownUser")}</span>
                        {holder?.email ? (
                          <span className="text-caption break-all text-muted-foreground">
                            {holder.email}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>{actionLabel(grant.action, t)}</TableCell>
                    <TableCell>
                      <div className="grid justify-items-start gap-1">
                        <span>{scopeLabel(grant, t)}</span>
                        {assetGone ? (
                          <Badge tone="warning" size="sm" title={t("access.scopeAssetGoneHint")}>
                            {t("access.scopeAssetGone")}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={grant.effect === "deny" ? "danger" : "success"}>
                        {t(grant.effect === "deny" ? "access.effectDeny" : "access.effectAllow")}
                      </Badge>
                    </TableCell>
                    {/* The server leaves out a writer the reader is not shown: that is no error. */}
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <div className="grid">
                        <span>{grantedBy?.displayLabel ?? t("access.notAvailable")}</span>
                        <span className="text-caption">{formatDate(grant.createdAt, locale)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="w-0 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            size="sm"
                            label={t("access.grantMenu", { name: holderName(grant) })}
                          >
                            <Ellipsis aria-hidden="true" />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            tone="danger"
                            icon={<Undo2 aria-hidden="true" />}
                            onSelect={() => setPendingRevoke(grant)}
                          >
                            {t("access.revoke")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}
      {granting ? (
        <GrantDialog
          users={users}
          usersFailed={usersFailed}
          namespaces={namespaces}
          assets={assets}
          assetsFailed={assetsFailed}
          onGrant={onGrant}
          onClose={() => setGranting(false)}
        />
      ) : null}
      {pendingRevoke ? (
        <ConfirmDialog
          open
          title={t("access.revokeTitle")}
          confirmLabel={t("access.revoke")}
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
              name: holderName(pendingRevoke),
              action: actionLabel(pendingRevoke.action, t),
              scope: scopeLabel(pendingRevoke, t)
            }
          )}
        </ConfirmDialog>
      ) : null}
    </div>
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
  const sentence =
    failure === "duplicateGrant" && error instanceof GrantWriteError
      ? t("access.grantDuplicate", { action: actionLabel(error.request.action, t) })
      : t(failureKeys[failure] ?? "access.grantFailed");
  return error instanceof GrantWriteError && error.written > 0
    ? `${sentence} ${t("access.grantPartlyWritten", { written: error.written, total: error.total })}`
    : sentence;
}

function GrantDialog({
  users,
  usersFailed,
  namespaces,
  assets,
  assetsFailed,
  onGrant,
  onClose
}: Pick<
  GrantsTabProps,
  "users" | "usersFailed" | "namespaces" | "assets" | "assetsFailed" | "onGrant"
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
            error={assetsFailed ? t("access.referencesLoadFailed") : undefined}
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
