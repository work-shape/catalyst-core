import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { AdministeredUser, UpdateAdministeredUserRequest } from "@vivd-catalyst/api-client";
import type { Permission } from "@vivd-catalyst/core";
import { Badge, Card, CardContent, CardHeader, CardTitle, Switch } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import {
  USER_PERMISSION_SOURCE_LABEL_KEYS,
  errorMessage,
  setUserPermission,
  userPermissionCopy,
  userPermissionStates,
  type FormNoticeState
} from "./user-administration-model";
import { FormNotice } from "./user-administration-primitives";

/**
 * Typed permissions of one user. Each toggle saves on its own through the user
 * update, so it never competes with unsaved edits in the profile form.
 */
export function UserPermissionsCard({
  user,
  canManageSuperadminAccess,
  disabledReason,
  mutating,
  onUpdateUser
}: {
  user: AdministeredUser;
  canManageSuperadminAccess: boolean;
  disabledReason?: string;
  mutating: boolean;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
}) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<FormNoticeState>();
  // Shows the new position right away; the saved user replaces it on refetch.
  const [savedChange, setSavedChange] = useState<{ permission: Permission; held: boolean }>();

  useEffect(() => {
    setSavedChange(undefined);
  }, [user.id, user.updatedAt]);

  useEffect(() => {
    setNotice(undefined);
  }, [user.id]);

  async function toggle(permission: Permission, held: boolean) {
    setNotice(undefined);
    setSavedChange({ permission, held });
    try {
      await onUpdateUser(user.id, { permissions: setUserPermission(user, permission, held) });
    } catch (error) {
      setSavedChange(undefined);
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck size={17} aria-hidden="true" />
          {t("userRights")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">{t("userRightsDescription")}</p>
        <ul className="grid divide-y rounded-md border">
          {userPermissionStates(user).map((state) => {
            const copy = userPermissionCopy(state.permission);
            const label = copy ? t(copy.label) : state.permission;
            const held =
              savedChange?.permission === state.permission ? savedChange.held : state.held;
            // The server lets only superadmins hand out these two permissions.
            const superadminOnly =
              (state.permission === "api_access.manage" ||
                state.permission === "agent_models.manage") &&
              !canManageSuperadminAccess;
            return (
              <li
                key={state.permission}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-sm"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{label}</span>
                    {state.source !== "none" ? (
                      <Badge appearance="outline" className="font-normal text-muted-foreground">
                        {t(USER_PERMISSION_SOURCE_LABEL_KEYS[state.source])}
                      </Badge>
                    ) : null}
                  </span>
                  {copy ? (
                    <span className="text-xs text-muted-foreground">{t(copy.description)}</span>
                  ) : null}
                  {superadminOnly ? (
                    <span className="text-xs text-muted-foreground">
                      {t("userRightSuperadminOnly")}
                    </span>
                  ) : null}
                </div>
                <Switch
                  aria-label={label}
                  checked={held}
                  disabled={mutating || Boolean(disabledReason) || superadminOnly}
                  onCheckedChange={(checked) => void toggle(state.permission, checked)}
                />
              </li>
            );
          })}
        </ul>
        {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}
        <FormNotice notice={notice} />
      </CardContent>
    </Card>
  );
}
