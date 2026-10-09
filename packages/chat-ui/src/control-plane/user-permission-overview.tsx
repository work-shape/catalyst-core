import { Check, X } from "lucide-react";
import type { AdministeredUser } from "@vivd-catalyst/api-client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import {
  USER_PERMISSIONS,
  USER_PERMISSION_SOURCE_LABEL_KEYS,
  userPermissionCopy,
  userPermissionStates,
  type UserPermissionSource
} from "./user-administration-model";
import { UserAvatar } from "./user-administration-primitives";

/**
 * Read-only matrix of who holds which permission. Editing stays in the user
 * detail, which every row opens.
 */
export function UserPermissionOverview({
  users,
  onSelectUser
}: {
  users: AdministeredUser[];
  onSelectUser(userId: string): void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="sticky left-0 z-10 bg-muted px-4 text-[11px] font-semibold tracking-[0.05em] uppercase">
              {t("userRightsOverviewUser")}
            </TableHead>
            {USER_PERMISSIONS.map((permission) => {
              const copy = userPermissionCopy(permission);
              return (
                <TableHead
                  key={permission}
                  scope="col"
                  className="min-w-28 max-w-36 px-3 py-2 text-center align-bottom whitespace-normal"
                >
                  {copy ? t(copy.label) : permission}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow
              key={user.id}
              className="group cursor-pointer hover:bg-muted/50"
              onClick={() => onSelectUser(user.id)}
            >
              <TableHead
                scope="row"
                className="sticky left-0 z-10 h-auto bg-card px-4 py-2.5 font-normal text-foreground group-hover:bg-muted"
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectUser(user.id);
                  }}
                >
                  <UserAvatar displayLabel={user.displayLabel} />
                  <span className="max-w-48 truncate text-sm font-medium">{user.displayLabel}</span>
                </button>
              </TableHead>
              {userPermissionStates(user).map((state) => (
                <TableCell key={state.permission} className="px-3 text-center">
                  <PermissionMark source={state.source} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-4 py-3 text-xs text-muted-foreground">
        {(["role", "granted", "revoked"] as const).map((source) => (
          <span key={source} className="inline-flex items-center gap-1.5" aria-hidden="true">
            <PermissionMark source={source} legend />
            {t(USER_PERMISSION_SOURCE_LABEL_KEYS[source])}
          </span>
        ))}
      </div>
    </>
  );
}

/** `legend` marks sit next to their visible label and need no text of their own. */
function PermissionMark({ source, legend }: { source: UserPermissionSource; legend?: boolean }) {
  const { t } = useTranslation();
  if (source === "none") {
    return null;
  }
  const label = t(USER_PERMISSION_SOURCE_LABEL_KEYS[source]);
  return (
    <span
      className="inline-grid size-6 place-items-center align-middle"
      title={legend ? undefined : label}
    >
      {source === "role" ? (
        <Check size={15} className="text-muted-foreground" aria-hidden="true" />
      ) : source === "granted" ? (
        <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check size={13} strokeWidth={2.5} aria-hidden="true" />
        </span>
      ) : (
        <X size={14} className="text-muted-foreground/70" aria-hidden="true" />
      )}
      {legend ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}
