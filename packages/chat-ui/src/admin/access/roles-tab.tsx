// @rights-screen: included in the rights wording guard.
import { Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { Role } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  FormNotice,
  Input,
  List,
  ListRow,
  Select,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { ScopeNames } from "./grant-sentences";
import { canEditRole, copiedGrants, editorHolds, type RoleEditor } from "./role-model";
import { RolePage } from "./role-page";
import {
  RoleMenu,
  roleDescription,
  roleFailureText,
  roleName,
  type RoleWrites
} from "./role-parts";

export interface RolesTabProps extends RoleWrites {
  /** Absent while the roles load. */
  roles: readonly Role[] | undefined;
  loadFailed: boolean;
  onRetry(): void;
  editor: RoleEditor;
  /** The role whose page is open; none shows the list. */
  selectedRoleId: string | undefined;
  onSelect(roleId: string | undefined): void;
  /** The names of the workspaces and assets a role's grant may name. */
  names: ScopeNames;
  /** An active instance admin, whom a refusal names as the one who can help. */
  instanceAdminName?: string;
}

/**
 * Instance > Access > Roles: `user`, `admin` and `superadmin`, then the custom roles. A new role
 * copies the rights of another; a custom role is renamed and deleted from its row. A row opens
 * the role's page.
 */
export function RolesTab(props: RolesTabProps) {
  const { roles, loadFailed, onRetry, editor, selectedRoleId, onSelect, instanceAdminName } = props;
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Role | undefined>();
  const [deleting, setDeleting] = useState<Role | undefined>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const writesRoles = editorHolds(editor, "users.manage");
  const selected = roles?.find((role) => role.id === selectedRoleId);

  if (selected !== undefined) {
    return (
      <RolePage
        role={selected}
        editor={editor}
        names={props.names}
        instanceAdminName={instanceAdminName}
        onBack={() => onSelect(undefined)}
        onRename={() => setRenaming(selected)}
        onDelete={() => setDeleting(selected)}
        onUpdate={props.onUpdate}
        onReset={props.onReset}
        onDecide={props.onDecide}
        dialogs={
          <RoleDialogs
            {...props}
            renaming={renaming}
            deleting={deleting}
            deleteBusy={deleteBusy}
            onCloseRename={() => setRenaming(undefined)}
            onCloseDelete={() => setDeleting(undefined)}
            onDeleted={() => onSelect(undefined)}
            setDeleteBusy={setDeleteBusy}
            setFailure={setFailure}
          />
        }
        failure={failure}
        onDismissFailure={() => setFailure(undefined)}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-body text-muted-foreground">{t("access.rolesIntro")}</p>
        <Button
          size="sm"
          disabled={!writesRoles || roles === undefined}
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" />
          {t("access.newRole")}
        </Button>
      </div>
      {failure !== undefined ? (
        <Banner tone="danger" onDismiss={() => setFailure(undefined)}>
          {failure}
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
          {t("access.rolesLoadFailed")}
        </Banner>
      ) : roles === undefined ? (
        <SkeletonList rows={3} />
      ) : (
        <List aria-label={t("access.tabRoles")}>
          {roles.map((role) => (
            <RoleRow
              key={role.id}
              role={role}
              editable={canEditRole(role, editor)}
              onOpen={() => onSelect(role.id)}
              onRename={() => setRenaming(role)}
              onDelete={() => setDeleting(role)}
            />
          ))}
        </List>
      )}
      {creating && roles !== undefined ? (
        <NewRoleDialog
          roles={roles}
          instanceAdminName={instanceAdminName}
          onCreate={props.onCreate}
          onCreated={(role) => {
            setCreating(false);
            onSelect(role.id);
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
      <RoleDialogs
        {...props}
        renaming={renaming}
        deleting={deleting}
        deleteBusy={deleteBusy}
        onCloseRename={() => setRenaming(undefined)}
        onCloseDelete={() => setDeleting(undefined)}
        onDeleted={() => undefined}
        setDeleteBusy={setDeleteBusy}
        setFailure={setFailure}
      />
    </div>
  );
}

/** One role of the list: its name, what it is for, and how it stands. */
function RoleRow({
  role,
  editable,
  onOpen,
  onRename,
  onDelete
}: {
  role: Role;
  editable: boolean;
  onOpen(): void;
  onRename(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  const name = roleName(role, t);
  const count = role.grants.length;
  const pending = role.pendingActions.length;
  return (
    <ListRow
      data-testid="role-row"
      data-role={role.id}
      title={name}
      description={roleDescription(role, t)}
      descriptionWraps
      onClick={onOpen}
      chips={
        <>
          {role.builtIn ? (
            <Badge size="sm" appearance="outline">
              {t("access.roleBuiltIn")}
            </Badge>
          ) : null}
          {!role.editable ? (
            <Badge size="sm">{t("access.roleReadOnly")}</Badge>
          ) : role.equalsDefault === false ? (
            <Badge size="sm" tone="info">
              {t("access.roleChanged")}
            </Badge>
          ) : null}
          <Badge size="sm">
            {t(count === 1 ? "access.roleRightsOne" : "access.roleRightsOther", { count })}
          </Badge>
          {pending > 0 ? (
            <Badge size="sm" tone="warning" dot>
              {t(pending === 1 ? "access.rolePendingOne" : "access.rolePendingOther", {
                count: pending
              })}
            </Badge>
          ) : null}
        </>
      }
      actionsVisible
      actions={
        !role.builtIn && editable ? (
          <RoleMenu name={name} onRename={onRename} onDelete={onDelete} />
        ) : undefined
      }
    />
  );
}

/** The rename and the delete dialog, wherever the role list or a role's page opens them. */
function RoleDialogs({
  renaming,
  deleting,
  deleteBusy,
  instanceAdminName,
  onUpdate,
  onDelete,
  onCloseRename,
  onCloseDelete,
  onDeleted,
  setDeleteBusy,
  setFailure
}: Pick<RolesTabProps, "instanceAdminName" | "onUpdate" | "onDelete"> & {
  renaming: Role | undefined;
  deleting: Role | undefined;
  deleteBusy: boolean;
  onCloseRename(): void;
  onCloseDelete(): void;
  onDeleted(): void;
  setDeleteBusy(busy: boolean): void;
  setFailure(text: string | undefined): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {renaming ? (
        <RenameRoleDialog
          role={renaming}
          instanceAdminName={instanceAdminName}
          onSave={(body) => onUpdate(renaming.id, body)}
          onClose={onCloseRename}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title={t("access.deleteRoleTitle", { name: deleting.name })}
          confirmLabel={t("access.roleDelete")}
          loading={deleteBusy}
          onConfirm={() => {
            setDeleteBusy(true);
            setFailure(undefined);
            onDelete(deleting.id)
              .then(onDeleted)
              .catch((error: unknown) => setFailure(roleFailureText(error, t, instanceAdminName)))
              .finally(() => {
                setDeleteBusy(false);
                onCloseDelete();
              });
          }}
          onClose={onCloseDelete}
        >
          {t("access.deleteRoleDescription")}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** A new role: a name, and the role whose rights it starts with. */
function NewRoleDialog({
  roles,
  instanceAdminName,
  onCreate,
  onCreated,
  onClose
}: {
  roles: readonly Role[];
  instanceAdminName: string | undefined;
  onCreate: RoleWrites["onCreate"];
  onCreated(role: Role): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceId, setSourceId] = useState(roles[0]?.id ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const source = roles.find((role) => role.id === sourceId);
  const nameMissing = name.trim() === "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFailure(undefined);
    if (nameMissing || source === undefined) return;
    setSaving(true);
    onCreate({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      grants: copiedGrants(source)
    })
      .then(onCreated)
      .catch((error: unknown) => setFailure(roleFailureText(error, t, instanceAdminName)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={t("access.newRole")}
      description={t("access.newRoleDescription")}
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
          <Button type="submit" form={formId} loading={saving}>
            {t("access.roleCreate")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        <Field label={t("access.roleCopyFrom")} required>
          <Select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {roleName(role, t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t("access.roleName")}
          required
          error={submitted && nameMissing ? t("access.roleNameMissing") : undefined}
        >
          <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("access.roleDescription")} optional>
          <Input
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** A custom role's name and description. */
function RenameRoleDialog({
  role,
  instanceAdminName,
  onSave,
  onClose
}: {
  role: Role;
  instanceAdminName: string | undefined;
  onSave(body: { name: string; description: string | null }): Promise<unknown>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const nameMissing = name.trim() === "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFailure(undefined);
    if (nameMissing) return;
    setSaving(true);
    onSave({ name: name.trim(), description: description.trim() || null })
      .then(onClose)
      .catch((error: unknown) => setFailure(roleFailureText(error, t, instanceAdminName)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog
      open
      title={t("access.renameRoleTitle", { name: role.name })}
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
          <Button type="submit" form={formId} loading={saving}>
            {t("access.roleSave")}
          </Button>
        </>
      }
      onClose={onClose}
    >
      <form id={formId} className="grid gap-5" noValidate onSubmit={submit}>
        <Field
          label={t("access.roleName")}
          required
          error={submitted && nameMissing ? t("access.roleNameMissing") : undefined}
        >
          <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("access.roleDescription")} optional>
          <Input
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
