// @rights-screen: included in the rights wording guard.
import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import type { AdministeredUser, Role } from "@work-shape/catalyst-api-client";
import { isBuiltInRole } from "@work-shape/catalyst-core";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormNotice,
  Picker,
  PickerButton
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { canAssignRole, type RoleEditor } from "./role-model";
import { roleAssignmentFailureText } from "./role-parts";

/**
 * The custom roles a person holds beside their built-in role (P30), chosen from the instance's
 * custom roles. Each choice saves on its own through the user update, which keeps the built-in
 * role as it is and asks the rules of giving a role.
 */
export function UserRolesCard({
  user,
  roles,
  rolesFailed,
  editor,
  disabledReason,
  instanceAdminName,
  onSetRoles
}: {
  user: AdministeredUser;
  /** The roles of the instance; absent while they load. */
  roles: readonly Role[] | undefined;
  rolesFailed: boolean;
  editor: RoleEditor;
  /** Why the viewer changes nothing of this person, such as a Superadmin's account. */
  disabledReason?: string;
  instanceAdminName?: string;
  onSetRoles(userId: string, roles: string[]): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const held = user.roles.filter((role) => !isBuiltInRole(role));
  // Shows the new choice at once; the saved user replaces it on refetch.
  const [chosen, setChosen] = useState<string[] | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  useEffect(() => setChosen(undefined), [user.id, user.updatedAt]);
  useEffect(() => setFailure(undefined), [user.id]);

  const custom = (roles ?? []).filter((role) => !role.builtIn);
  const value = chosen ?? held;
  const nameOf = (roleId: string) => custom.find((role) => role.id === roleId)?.name ?? roleId;

  const save = (next: string[]) => {
    setFailure(undefined);
    setChosen(next);
    onSetRoles(user.id, [...user.roles.filter((role) => isBuiltInRole(role)), ...next]).catch(
      (error: unknown) => {
        setChosen(undefined);
        setFailure(roleAssignmentFailureText(error, t, instanceAdminName));
      }
    );
  };

  return (
    <Card data-testid="user-roles">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers size={17} aria-hidden="true" />
          {t("access.userMoreRoles")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">{t("access.userMoreRolesDescription")}</p>
        {rolesFailed ? (
          <FormNotice tone="error">{t("access.rolesLoadFailed")}</FormNotice>
        ) : roles !== undefined && custom.length === 0 && held.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("access.userMoreRolesNone")}</p>
        ) : (
          <Picker
            multiple
            label={t("access.userMoreRoles")}
            options={custom.map((role) => {
              const assignable = canAssignRole(role, editor);
              return {
                value: role.id,
                label: role.name,
                ...(role.description ? { description: role.description } : {}),
                disabled: !assignable,
                // While the viewer's own rights load, nothing is offered and nothing is said.
                ...(assignable || editor.rights === undefined
                  ? {}
                  : { disabledReason: t("access.roleHolderSuperadminOnly") })
              };
            })}
            value={value}
            onValueChange={save}
          >
            <PickerButton
              label={t("access.userMoreRoles")}
              placeholder={t("access.userMoreRolesPlaceholder")}
              value={value.length > 0 ? value.map(nameOf).join(", ") : undefined}
              disabled={roles === undefined || Boolean(disabledReason)}
            />
          </Picker>
        )}
        {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}
        {failure !== undefined ? <FormNotice tone="error">{failure}</FormNotice> : null}
      </CardContent>
    </Card>
  );
}
