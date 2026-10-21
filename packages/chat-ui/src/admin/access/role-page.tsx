// @rights-screen: included in the rights wording guard.
import { ArrowLeft, Ban, Ellipsis, PencilLine, RotateCcw, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Role } from "@work-shape/catalyst-api-client";
import type { RolePendingDecision } from "@work-shape/catalyst-core";
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
  FormNotice,
  IconButton,
  List,
  ListRow,
  Section
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { refusalAskingInstanceAdmin } from "../settings/ask-instance-admin";
import { rightSentenceKey } from "./grant-words";
import { rightAreaLabelKey } from "./effective-rights-model";
import { grantSentences, scopeLabel, type ScopeNames } from "./grant-sentences";
import { actionLabel } from "./right-words";
import {
  EDIT_BUILT_IN_ROLES_ACTION,
  areaRightChoices,
  canEditRole,
  roleAreaOf,
  roleGrantsByArea,
  withAreaAllows,
  withoutGrant,
  type RightLock,
  type RoleArea,
  type RoleEditor,
  type RoleGrant
} from "./role-model";
import {
  RoleMenu,
  roleDescription,
  roleFailureText,
  roleName,
  type RoleWrites
} from "./role-parts";

type Translate = TranslationContextValue["t"];

const lockKeys = {
  superadminOnly: "userRightSuperadminOnly",
  refusedByRole: "access.rightRefusedByRole",
  notHeld: "access.rightNotHeld"
} as const satisfies Record<RightLock, string>;

/** A label starts with a capital, wherever its sentence put the verb. */
function sentenceStart(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export interface RolePageProps extends Pick<RoleWrites, "onUpdate" | "onReset" | "onDecide"> {
  role: Role;
  editor: RoleEditor;
  names: ScopeNames;
  instanceAdminName?: string;
  onBack(): void;
  onRename(): void;
  onDelete(): void;
  /** The rename and delete dialogs of the tab, shown over this page. */
  dialogs?: ReactNode;
  /** A write of the tab that failed, such as a delete. */
  failure?: string;
  onDismissFailure?(): void;
}

/**
 * One role's page: its rights by area, each area in sentences as the Rights tab says a person's
 * rows. Who may change the role edits an area's rights on the whole instance and removes any
 * grant; `user` and `admin` are reset to their default and decide what a release brought;
 * `superadmin` is read-only.
 */
export function RolePage({
  role,
  editor,
  names,
  instanceAdminName,
  onBack,
  onRename,
  onDelete,
  onUpdate,
  onReset,
  onDecide,
  dialogs,
  failure,
  onDismissFailure
}: RolePageProps) {
  const { t, locale } = useTranslation();
  const name = roleName(role, t);
  const editable = canEditRole(role, editor);
  const [editingArea, setEditingArea] = useState<RoleArea | undefined>();
  const [removing, setRemoving] = useState<RoleGrant | undefined>();
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const fail = (cause: unknown) => setError(roleFailureText(cause, t, instanceAdminName));
  const areas = roleGrantsByArea(role.grants);
  const editableBuiltIn = role.builtIn && role.editable;

  const decide = (action: string, decision: RolePendingDecision) => {
    setDeciding(action);
    setError(undefined);
    onDecide(role.id, action, decision)
      .catch(fail)
      .finally(() => setDeciding(undefined));
  };

  return (
    <div className="grid gap-6" data-testid="role-page" data-role={role.id}>
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {t("access.allRoles")}
        </Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-title">{name}</h2>
            {role.builtIn ? (
              <Badge size="sm" appearance="outline">
                {t("access.roleBuiltIn")}
              </Badge>
            ) : null}
            {!role.editable ? (
              <Badge size="sm">{t("access.roleReadOnly")}</Badge>
            ) : role.equalsDefault === undefined ? null : (
              <Badge size="sm" tone={role.equalsDefault ? "neutral" : "info"}>
                {t(role.equalsDefault ? "access.roleAsDelivered" : "access.roleChanged")}
              </Badge>
            )}
          </div>
          {roleDescription(role, t) ? (
            <p className="max-w-prose text-body text-muted-foreground">
              {roleDescription(role, t)}
            </p>
          ) : null}
        </div>
        {editable && editableBuiltIn ? (
          <Button
            variant="outline"
            size="sm"
            disabled={role.equalsDefault === true && role.pendingActions.length === 0}
            onClick={() => setResetting(true)}
          >
            <RotateCcw aria-hidden="true" />
            {t("access.roleResetToDefault")}
          </Button>
        ) : editable && !role.builtIn ? (
          <RoleMenu name={name} onRename={onRename} onDelete={onDelete} />
        ) : null}
      </div>
      {editableBuiltIn && !editable ? (
        <Banner>
          {refusalAskingInstanceAdmin(
            t("access.roleBuiltInNotEditable", {
              right: actionLabel(EDIT_BUILT_IN_ROLES_ACTION, t)
            }),
            t,
            instanceAdminName
          )}
        </Banner>
      ) : editableBuiltIn ? (
        <Banner layout="line">{t("access.roleBuiltInEffect")}</Banner>
      ) : null}
      {[error, failure].map((text, index) =>
        text === undefined ? null : (
          <Banner
            key={index}
            tone="danger"
            onDismiss={index === 0 ? () => setError(undefined) : onDismissFailure}
          >
            {text}
          </Banner>
        )
      )}
      <PendingActions role={role} editable={editable} deciding={deciding} onDecide={decide} />
      {areas.map(({ area, grants, places }) => {
        const areaName = t(rightAreaLabelKey(area));
        return (
          <Section
            key={area}
            layout="stacked"
            data-testid="role-area"
            data-area={area}
            title={areaName}
            count={grants.length}
            action={
              editable ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("access.areaEditLabel", { area: areaName })}
                    onClick={() => setEditingArea(area)}
                  >
                    <PencilLine aria-hidden="true" />
                    {t("access.areaEdit")}
                  </Button>
                  {grants.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          size="sm"
                          label={t("access.areaRemoveLabel", { area: areaName })}
                        >
                          <Ellipsis aria-hidden="true" />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {grants.map((grant) => (
                          <DropdownMenuItem
                            key={`${grant.action}:${grant.effect}:${grant.scopeKind}:${grant.scopeId ?? ""}`}
                            tone="danger"
                            icon={<Undo2 aria-hidden="true" />}
                            onSelect={() => setRemoving(grant)}
                          >
                            {t(
                              grant.effect === "deny"
                                ? "access.revokeDenyItem"
                                : "access.revokeAllowItem",
                              { action: grantLabel(grant, t, names) }
                            )}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              ) : undefined
            }
          >
            {places.length === 0 ? (
              <p className="text-body text-muted-foreground">{t("access.areaNone")}</p>
            ) : (
              <ul className="grid min-w-0 gap-1.5">
                {places.flatMap((place) =>
                  grantSentences(place.place, place.grants, t, locale, names).map((sentence) => (
                    <li
                      key={`${place.key}:${sentence.effect}:${sentence.text}`}
                      data-effect={sentence.effect}
                      className="flex min-w-0 items-start gap-1.5 break-words"
                    >
                      {sentence.effect === "deny" ? (
                        <Badge tone="danger" appearance="outline" size="sm">
                          <Ban aria-hidden="true" />
                          {t("access.rowDenied")}
                        </Badge>
                      ) : null}
                      <span className="min-w-0">{sentenceStart(sentence.text)}</span>
                    </li>
                  ))
                )}
              </ul>
            )}
          </Section>
        );
      })}
      {editingArea !== undefined ? (
        <AreaDialog
          role={role}
          roleLabel={name}
          area={editingArea}
          editor={editor}
          instanceAdminName={instanceAdminName}
          onSave={(grants) => onUpdate(role.id, { grants })}
          onClose={() => setEditingArea(undefined)}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          open
          title={t(removing.effect === "deny" ? "access.revokeDenyTitle" : "access.revokeTitle")}
          confirmLabel={t(removing.effect === "deny" ? "access.revokeDeny" : "access.revoke")}
          loading={busy}
          onConfirm={() => {
            setBusy(true);
            setError(undefined);
            onUpdate(role.id, { grants: withoutGrant(role.grants, removing) })
              .catch(fail)
              .finally(() => {
                setBusy(false);
                setRemoving(undefined);
              });
          }}
          onClose={() => setRemoving(undefined)}
        >
          {t(
            removing.effect === "deny"
              ? "access.roleRevokeDenyDescription"
              : "access.roleRevokeAllowDescription",
            {
              name,
              action: actionLabel(removing.action, t),
              scope: scopeLabel(placeOf(removing), t, names)
            }
          )}
        </ConfirmDialog>
      ) : null}
      {resetting ? (
        <ConfirmDialog
          open
          title={t("access.roleResetTitle", { name })}
          confirmLabel={t("access.roleResetToDefault")}
          loading={busy}
          onConfirm={() => {
            setBusy(true);
            setError(undefined);
            onReset(role.id)
              .catch(fail)
              .finally(() => {
                setBusy(false);
                setResetting(false);
              });
          }}
          onClose={() => setResetting(false)}
        >
          {t("access.roleResetDescription")}
        </ConfirmDialog>
      ) : null}
      {dialogs}
    </div>
  );
}

/** Where one grant of a role applies, as the sentences read it. */
function placeOf(grant: RoleGrant) {
  const kind = grant.action.slice(0, Math.max(grant.action.indexOf("."), 0));
  return {
    scopeKind: grant.scopeKind,
    ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId }),
    ...(grant.scopeKind === "asset" ? { scopeAsset: { kind, active: true } } : {})
  };
}

/** A grant in a menu: its right, and its place where that is not the whole instance. */
function grantLabel(grant: RoleGrant, t: Translate, names: ScopeNames): string {
  const action = actionLabel(grant.action, t);
  return grant.scopeKind === "instance"
    ? action
    : t("access.rowOwnAt", { action, scope: scopeLabel(placeOf(grant), t, names) });
}

/**
 * What a release changed in the default of an edited built-in role and nobody decided yet:
 * each new right with Add and Leave out, each right the default lost with Remove and Keep.
 */
function PendingActions({
  role,
  editable,
  deciding,
  onDecide
}: {
  role: Role;
  editable: boolean;
  deciding: string | undefined;
  onDecide(action: string, decision: RolePendingDecision): void;
}) {
  const { t } = useTranslation();
  return (["added", "removed"] as const).map((change) => {
    const pending = role.pendingActions.filter((entry) => entry.change === change);
    if (pending.length === 0) return null;
    const count = pending.length;
    const title =
      change === "added"
        ? t(count === 1 ? "access.pendingAddedOne" : "access.pendingAddedOther", { count })
        : t(count === 1 ? "access.pendingRemovedOne" : "access.pendingRemovedOther", { count });
    return (
      <Section
        key={change}
        layout="stacked"
        data-testid="role-pending"
        data-change={change}
        title={title}
        state={
          <Badge tone="warning" size="sm" dot>
            {t(count === 1 ? "access.rolePendingOne" : "access.rolePendingOther", { count })}
          </Badge>
        }
      >
        <List aria-label={title}>
          {pending.map((entry) => (
            <ListRow
              key={entry.action}
              data-testid="role-pending-action"
              data-action={entry.action}
              title={actionLabel(entry.action, t)}
              description={t(rightAreaLabelKey(roleAreaOf(entry.action)))}
              actionsVisible
              actions={
                editable ? (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant={change === "added" ? "primary" : "outline"}
                      loading={deciding === entry.action}
                      disabled={deciding !== undefined}
                      onClick={() => onDecide(entry.action, "apply")}
                    >
                      {t(change === "added" ? "access.pendingAdd" : "access.pendingTakeAway")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={deciding !== undefined}
                      onClick={() => onDecide(entry.action, "dismiss")}
                    >
                      {t(change === "added" ? "access.pendingLeaveOut" : "access.pendingKeep")}
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ))}
        </List>
      </Section>
    );
  });
}

/**
 * The rights of one area on the whole instance, one box each. A right the editor may not give
 * or take says why; the grants in one place and the refusals stay as they are.
 */
function AreaDialog({
  role,
  roleLabel,
  area,
  editor,
  instanceAdminName,
  onSave,
  onClose
}: {
  role: Role;
  roleLabel: string;
  area: RoleArea;
  editor: RoleEditor;
  instanceAdminName: string | undefined;
  onSave(grants: ReturnType<typeof withAreaAllows>): Promise<unknown>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const choices = areaRightChoices(area, role.grants, editor);
  const [ticked, setTicked] = useState<string[]>(() =>
    choices.filter((choice) => choice.checked).map((choice) => choice.action)
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const areaName = t(rightAreaLabelKey(area));

  const save = () => {
    setSaving(true);
    setFailure(undefined);
    onSave(withAreaAllows(role.grants, area, ticked))
      .then(onClose)
      .catch((error: unknown) => setFailure(roleFailureText(error, t, instanceAdminName)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={t("access.areaDialogTitle", { area: areaName, role: roleLabel })}
      description={t("access.areaDialogDescription")}
      footer={
        <>
          {failure !== undefined ? (
            <FormNotice tone="error" className="mr-auto">
              {failure}
            </FormNotice>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button loading={saving} onClick={save}>
            {t("access.roleSaveRights")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <fieldset className="grid gap-3" data-testid="role-area-rights">
        <legend className="sr-only">{areaName}</legend>
        {choices.map((choice) => {
          const sentence = rightSentenceKey(choice.action);
          const description = [
            ...(sentence === undefined ? [] : [t(sentence)]),
            ...(choice.lock === undefined ? [] : [t(lockKeys[choice.lock])])
          ].join(" ");
          const checked = ticked.includes(choice.action);
          return (
            <Checkbox
              key={choice.action}
              data-action={choice.action}
              label={actionLabel(choice.action, t)}
              description={description || undefined}
              checked={checked}
              // A right may always be taken away, except one only a superadmin hands out and one
              // the role refuses; it is given only by who holds it.
              disabled={
                choice.lock === "superadminOnly" ||
                choice.lock === "refusedByRole" ||
                (choice.lock === "notHeld" && !checked)
              }
              onCheckedChange={(next) =>
                setTicked((current) =>
                  next
                    ? [...current, choice.action]
                    : current.filter((action) => action !== choice.action)
                )
              }
            />
          );
        })}
      </fieldset>
    </Dialog>
  );
}
