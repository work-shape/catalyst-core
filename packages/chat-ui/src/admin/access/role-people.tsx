// @rights-screen: included in the rights wording guard.
import { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import type { AdministeredUser, Role } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  IconButton,
  List,
  ListRow,
  Picker,
  Section,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { canAssignRole, type RoleEditor } from "./role-model";
import { roleAssignmentFailureText } from "./role-parts";

/** From this many people on, the picker offers a search field. */
const PICKER_SEARCH_FROM_COUNT = 8;

/** The people of the instance as a custom role's page reads them. */
export interface RolePeopleSource {
  /** Absent while they load. */
  users: readonly AdministeredUser[] | undefined;
  failed: boolean;
  /** Sets a person's roles, through the user update and its rules of giving a role. */
  onSetRoles(userId: string, roles: string[]): Promise<unknown>;
}

/**
 * Who holds a custom role (P30): each person with a way to take it from them, and a picker of
 * the active people who do not hold it yet. Only a Superadmin's own account is out of reach of
 * an editor who is none.
 */
export function RolePeople({
  role,
  name,
  editor,
  people,
  instanceAdminName
}: {
  role: Role;
  name: string;
  editor: RoleEditor;
  people: RolePeopleSource;
  instanceAdminName?: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const assignable = canAssignRole(role, editor);
  const users = people.users;
  const holders = (users ?? []).filter((user) => user.roles.includes(role.id));
  const candidates = (users ?? []).filter(
    (user) =>
      user.status === "active" &&
      !user.roles.includes(role.id) &&
      (editor.superadmin || !user.roles.includes("superadmin"))
  );

  const change = (user: AdministeredUser, roles: string[]) => {
    setBusy(user.id);
    setFailure(undefined);
    people
      .onSetRoles(user.id, roles)
      .catch((error: unknown) => setFailure(roleAssignmentFailureText(error, t, instanceAdminName)))
      .finally(() => setBusy(undefined));
  };
  const add = (userId: string) => {
    const user = candidates.find((candidate) => candidate.id === userId);
    if (user) change(user, [...user.roles, role.id]);
  };

  return (
    <Section
      layout="stacked"
      data-testid="role-people"
      title={t("access.rolePeople")}
      count={users === undefined ? undefined : holders.length}
      action={
        assignable && users !== undefined ? (
          <Picker
            search={candidates.length >= PICKER_SEARCH_FROM_COUNT}
            label={t("access.rolePeoplePick")}
            options={candidates.map((user) => ({
              value: user.id,
              label: user.displayLabel,
              ...(user.email ? { description: user.email } : {})
            }))}
            value={undefined}
            onValueChange={add}
          >
            <Button variant="ghost" size="sm" disabled={busy !== undefined}>
              <UserPlus aria-hidden="true" />
              {t("access.rolePeopleAdd")}
            </Button>
          </Picker>
        ) : undefined
      }
    >
      <div className="grid gap-3">
        {failure !== undefined ? (
          <Banner tone="danger" onDismiss={() => setFailure(undefined)}>
            {failure}
          </Banner>
        ) : null}
        {people.failed ? (
          <p className="text-body text-muted-foreground">{t("access.rolePeopleLoadFailed")}</p>
        ) : users === undefined ? (
          <SkeletonList rows={2} />
        ) : holders.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("access.rolePeopleNone")}</p>
        ) : (
          <List aria-label={t("access.rolePeople")}>
            {holders.map((user) => (
              <ListRow
                key={user.id}
                data-testid="role-holder"
                data-user={user.id}
                title={user.displayLabel}
                description={user.email}
                actionsVisible
                actions={
                  assignable && (editor.superadmin || !user.roles.includes("superadmin")) ? (
                    <IconButton
                      size="sm"
                      label={t("access.rolePeopleRemove", { role: name, name: user.displayLabel })}
                      disabled={busy !== undefined}
                      onClick={() =>
                        change(
                          user,
                          user.roles.filter((held) => held !== role.id)
                        )
                      }
                    >
                      <UserMinus aria-hidden="true" />
                    </IconButton>
                  ) : undefined
                }
              />
            ))}
          </List>
        )}
      </div>
    </Section>
  );
}
