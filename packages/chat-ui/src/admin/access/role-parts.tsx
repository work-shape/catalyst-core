// @rights-screen: included in the rights wording guard.
import { Ellipsis, PencilLine, Trash2 } from "lucide-react";
import type { Role, RoleGrantInput } from "@work-shape/catalyst-api-client";
import type { RolePendingDecision } from "@work-shape/catalyst-core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { refusalAskingInstanceAdmin } from "../settings/ask-instance-admin";
import { actionLabel } from "./right-words";
import { roleDescriptionKey, roleLabelKey, roleWriteFailure } from "./role-model";

// The words and the menu the role list and a role's page share.

type Translate = TranslationContextValue["t"];

/** A role's name as the page says it: a built-in role's in the reader's language. */
export function roleName(role: Pick<Role, "id" | "name">, t: Translate): string {
  const key = roleLabelKey(role.id);
  return key === undefined ? role.name : t(key);
}

/** What a role is for: its own description, or a built-in role's words. */
export function roleDescription(
  role: Pick<Role, "id" | "description">,
  t: Translate
): string | undefined {
  const key = roleDescriptionKey(role.id);
  return key === undefined ? role.description : t(key);
}

/**
 * The sentence for a role write that failed. A refusal that names a right says which, and
 * whom to ask; a held write says that nothing changed.
 */
export function roleFailureText(
  error: unknown,
  t: Translate,
  instanceAdminName: string | undefined
): string {
  const failure = roleWriteFailure(error);
  switch (failure.kind) {
    case "nameTaken":
      return t("access.roleNameTaken");
    case "inUse":
      return t("access.roleInUse");
    case "needsRight":
      return refusalAskingInstanceAdmin(
        t("access.roleNeedsRight", { right: actionLabel(failure.action, t) }),
        t,
        instanceAdminName
      );
    case "superadminOnly":
      return refusalAskingInstanceAdmin(t("access.roleSuperadminOnly"), t, instanceAdminName);
    case "other":
      return error instanceof Error && error.message === t("access.roleWaitsForApproval")
        ? error.message
        : t("access.roleWriteFailed");
  }
}

/** What the tab writes; each one rejects with the server's refusal. */
export interface RoleWrites {
  onCreate(body: { name: string; description?: string; grants: RoleGrantInput[] }): Promise<Role>;
  onUpdate(
    roleId: string,
    body: { name?: string; description?: string | null; grants?: RoleGrantInput[] }
  ): Promise<unknown>;
  onDelete(roleId: string): Promise<unknown>;
  onReset(roleId: string): Promise<unknown>;
  onDecide(roleId: string, action: string, decision: RolePendingDecision): Promise<unknown>;
}

/** The menu of a custom role: rename and delete. */
export function RoleMenu({
  name,
  onRename,
  onDelete
}: {
  name: string;
  onRename(): void;
  onDelete(): void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" label={t("access.roleMenu", { name })}>
          <Ellipsis aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem icon={<PencilLine aria-hidden="true" />} onSelect={onRename}>
          {t("access.roleRename")}
        </DropdownMenuItem>
        <DropdownMenuItem tone="danger" icon={<Trash2 aria-hidden="true" />} onSelect={onDelete}>
          {t("access.roleDelete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
