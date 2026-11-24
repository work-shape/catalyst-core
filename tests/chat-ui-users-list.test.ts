// @vitest-environment happy-dom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createApiClient, type AdministeredUser } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { ROLE_DEFAULT_ACTIONS, type Permission } from "@work-shape/catalyst-core";
import {
  USER_PERMISSIONS,
  UserPermissionsCard,
  filterUsers,
  formToUpdateInput,
  setUserPermission,
  userDisplayStatus,
  userPermissionCopy,
  userPermissionStates,
  userStatusFilterOf,
  userToForm
} from "./support/chat-ui";
import { TranslationProvider } from "./support/chat-ui/shared";
import { resolveEffectivePermissions } from "./support/ap4-verify/pre-ap4-permissions";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  waitForText
} from "./chat-ui-settings-fixtures";

// Instance > Users: the status an account reads with, the rights model and the page's changes.

function user(overrides: Partial<AdministeredUser> = {}): AdministeredUser {
  return {
    id: "user-1",
    clientInstanceId: "client-1",
    displayLabel: "Anna Beispiel",
    email: "anna@example.test",
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    status: "active",
    createdAt: "2026-10-01T08:00:00Z",
    updatedAt: "2026-10-01T08:00:00Z",
    identities: [],
    ...overrides
  };
}

const signedIn = { lastAuthenticatedAt: "2026-10-15T09:30:00Z" };

describe("the status an account reads with", () => {
  it("is invited for an active account nobody has signed in to yet, and the stored status else", () => {
    expect(userDisplayStatus(user())).toBe("invited");
    expect(userDisplayStatus(user(signedIn))).toBe("active");
    // The contract keeps no invitation, so only an account that could sign in reads invited.
    expect(userDisplayStatus(user({ status: "disabled" }))).toBe("disabled");
    expect(userDisplayStatus(user({ status: "deleting" }))).toBe("deleting");
  });

  it("is what the status filter selects by", () => {
    const invited = user({ id: "invited" });
    const active = user({ id: "active", ...signedIn });
    const filter = (value: string) =>
      filterUsers([invited, active], {
        search: "",
        statusFilter: userStatusFilterOf(value),
        roleFilter: "all"
      }).map((shown) => shown.id);

    expect(filter("invited")).toEqual(["invited"]);
    expect(filter("active")).toEqual(["active"]);
    expect(filter("all")).toEqual(["invited", "active"]);
    expect(filter("pending")).toEqual(["invited", "active"]);
  });
});

describe("saving the profile", () => {
  it("keeps the roles the form does not edit, a custom role among them", () => {
    const held = user({ roles: ["user", "role_buchhaltung"] });
    const form = { ...userToForm(held), displayLabel: "Anne" };

    expect(formToUpdateInput(form, held).roles).toEqual(["user", "role_buchhaltung"]);
    expect(formToUpdateInput({ ...form, accessLevel: "admin" }, held).roles).toEqual([
      "user",
      "admin",
      "role_buchhaltung"
    ]);
  });
});

function stateOf(subject: AdministeredUser, permission: Permission) {
  return userPermissionStates(subject).find((state) => state.permission === permission);
}

describe("user permission model", () => {
  it("offers every typed permission except the release permission of service tokens", () => {
    expect(USER_PERMISSIONS).toContain("agent_skills.approve");
    expect(USER_PERMISSIONS).not.toContain("config_assets.release");
    for (const permission of USER_PERMISSIONS) {
      expect(userPermissionCopy(permission), permission).toBeDefined();
    }
  });

  it("names where a permission comes from", () => {
    const admin = user({ roles: ["user", "admin"], permissions: ["!audit.view"] });
    const member = user({ permissions: ["agent_skills.approve"] });

    expect(stateOf(admin, "agent_skills.approve")).toMatchObject({ held: true, source: "role" });
    expect(stateOf(admin, "audit.view")).toMatchObject({ held: false, source: "revoked" });
    expect(stateOf(admin, "api_access.manage")).toMatchObject({ held: false, source: "none" });
    expect(stateOf(member, "agent_skills.approve")).toMatchObject({
      held: true,
      source: "granted"
    });
  });

  it("keeps the legacy permission display equal to the frozen pre-AP4 resolver", () => {
    const subjects = [
      user(),
      user({ permissions: ["agent_skills.approve", "!usage.view"] }),
      user({ roles: ["user", "admin"], permissions: ["!audit.view", "api_access.manage"] }),
      user({ roles: ["user", "admin", "superadmin"], permissions: ["!users.manage"] })
    ];

    for (const subject of subjects) {
      const effective = resolveEffectivePermissions(subject);
      for (const state of userPermissionStates(subject)) {
        expect(state.held, `${subject.roles.join("+")} ${state.permission}`).toBe(
          effective.has(state.permission)
        );
      }
    }
  });

  it("grants by adding the name and takes an individual grant away by removing it", () => {
    const member = user({ permissions: ["tool.custom"] });
    const granted = setUserPermission(member, "agent_skills.approve", true);

    expect(granted).toEqual(["tool.custom", "agent_skills.approve"]);
    expect(
      setUserPermission(user({ permissions: granted }), "agent_skills.approve", false)
    ).toEqual(["tool.custom"]);
    // A stale revocation gives way to a grant for a user whose role does not provide it.
    expect(setUserPermission(user({ permissions: ["!audit.view"] }), "audit.view", true)).toEqual([
      "audit.view"
    ]);
  });

  it("revokes a role default with a ! entry and restores it by removing that entry", () => {
    const admin = user({ roles: ["user", "admin"] });
    const revoked = setUserPermission(admin, "agent_skills.approve", false);

    expect(revoked).toEqual(["!agent_skills.approve"]);
    expect(
      setUserPermission(
        user({ roles: ["user", "admin"], permissions: revoked }),
        "agent_skills.approve",
        true
      )
    ).toEqual([]);
    // A redundant individual grant is replaced when its role default is revoked.
    expect(
      setUserPermission(
        user({ roles: ["user", "admin"], permissions: ["usage.view", "audit.view"] }),
        "usage.view",
        false
      )
    ).toEqual(["audit.view", "!usage.view"]);
  });

  it("leaves the entries alone when nothing has to change", () => {
    const admin = user({ roles: ["user", "admin"], permissions: ["agent_skills.approve"] });

    expect(setUserPermission(admin, "agent_skills.approve", true)).toEqual([
      "agent_skills.approve"
    ]);
    expect(setUserPermission(user(), "audit.view", false)).toEqual([]);
  });

  it("lets only a superadmin switch the rights only superadmins may hand out", () => {
    const disabledSwitches = (canManageSuperadminAccess: boolean) =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale: "en" },
          createElement(UserPermissionsCard, {
            user: user({ roles: ["user", "admin"] }),
            canManageSuperadminAccess,
            mutating: false,
            onUpdateUser: async () => user()
          })
        )
      ).match(/<button[^>]*role="switch"[^>]*disabled=""/gu)?.length ?? 0;

    expect(disabledSwitches(false)).toBe(2);
    expect(disabledSwitches(true)).toBe(0);
  });
});

const account: AdministeredUser = {
  id: "usr_managed",
  clientInstanceId: "client",
  displayLabel: "Managed person",
  email: "managed@example.test",
  roles: ["user"],
  permissionRefs: [],
  permissions: [],
  status: "active",
  createdAt: "2026-10-01T08:00:00Z",
  updatedAt: "2026-10-01T08:00:00Z",
  identities: [
    {
      authSource: "better-auth",
      externalUserId: "auth_managed",
      email: "managed@example.test",
      emailVerified: true,
      clientInstanceId: "client",
      userId: "usr_managed",
      createdAt: "2026-10-01T08:00:00Z",
      updatedAt: "2026-10-01T08:00:00Z"
    }
  ]
};

function button(name: string, within: ParentNode = document): HTMLButtonElement {
  return required(
    [...within.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === name
    )
  );
}

function rowButton(label: string, email: string): HTMLButtonElement {
  return required(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.includes(label) && item.textContent.includes(email)
    )
  );
}

async function fill(label: string, value: string, within: ParentNode = document) {
  const fieldLabel = [...within.querySelectorAll("label")].find((item) =>
    item.textContent?.startsWith(label)
  );
  if (!fieldLabel)
    throw new Error(
      `Missing ${label}: ${[...within.querySelectorAll("label")].map((item) => item.textContent).join(" | ")}`
    );
  const input = required<HTMLInputElement>(fieldLabel.querySelector("input"));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function usersPage(roles: string[], users = [account], viewerId = "user_1") {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let rows = users;
  const client = createApiClient({
    baseUrl: SETTINGS_INSTANCE_URL,
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        // What the page's own reader holds: their roles' defaults on the whole instance.
        if (path === apiOperations["permissions.effective"].path) {
          const actions = roles.flatMap((role) =>
            role === "admin" || role === "superadmin" ? ROLE_DEFAULT_ACTIONS[role] : []
          );
          return Response.json({
            holderActive: true,
            items: actions.map((action) => ({
              action,
              effect: "allow",
              scopeKind: "instance",
              source: "role"
            }))
          });
        }
        return path === apiOperations["users.list"].path
          ? Response.json({ items: rows })
          : Response.json(
              { error: { code: "NOT_FOUND", message: "No fixture for this read" } },
              { status: 404 }
            );
      }
      const twoFactorReset = path.endsWith("/two-factor/reset");
      const body: unknown =
        request.method === "DELETE" || twoFactorReset ? undefined : await request.json();
      requests.push({ method: request.method, path, body });
      if (twoFactorReset) {
        rows = rows.map((row) => ({ ...row, twoFactorEnabled: false }));
        return Response.json({ ok: true, hadFactor: true });
      }
      if (request.method === "DELETE") {
        rows = [];
        return Response.json({ state: "deleted" });
      }
      if (path.endsWith("/password")) return Response.json({ ok: true });
      rows = [{ ...account, displayLabel: "Created person", email: "created@example.test" }];
      return Response.json(rows[0]);
    }
  });
  const page = required(administration.pages?.find((item) => item.id === "users"));
  const mounted = await mountPage(
    settingsPageContext(client, settingsUser({ roles, id: viewerId })),
    "en",
    createElement(page.component)
  );
  await waitForText(mounted.container, "Managed person");
  return { ...mounted, requests };
}

describe("the Users page", () => {
  it("lets an admin create a user without offering the superadmin role", async () => {
    const mounted = await usersPage(["user", "admin"]);
    try {
      await act(async () => button("New user").click());
      const dialog = required(document.querySelector('dialog[open], [role="dialog"]'));
      const roleLabel = required(
        [...dialog.querySelectorAll("label")].find(
          (item) => item.querySelector("span")?.textContent === "Role"
        )
      );
      const select = required(roleLabel.querySelector("select"));
      expect(select.querySelector('option[value="superadmin"]')).toBeNull();
      expect(select.querySelector('option[value="admin"]')).not.toBeNull();
      await fill("Display label", "Created person", dialog);
      await fill("Email", "created@example.test", dialog);
      await fill("Initial password", "created-person-password", dialog);
      await act(async () => button("Create user", dialog).click());
      await vi.waitFor(() => expect(mounted.requests).toHaveLength(1), {
        timeout: CONDITION_WAIT_MS
      });
      expect(mounted.requests).toEqual([
        {
          method: "POST",
          path: apiOperations["users.create"].path,
          body: expect.objectContaining({
            displayLabel: "Created person",
            email: "created@example.test",
            roles: ["user"],
            passwordSignIn: { password: "created-person-password" }
          })
        }
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("resets a person's password through their detail", async () => {
    const mounted = await usersPage(["superadmin"]);
    try {
      await act(async () => rowButton("Managed person", "managed@example.test").click());
      await waitForText(mounted.container, "Sign-in methods");
      await fill("New password", "replacement-person-password");
      await act(async () => button("Reset password").click());
      await waitForText(mounted.container, "Password updated");
      expect(mounted.requests).toEqual([
        {
          method: "POST",
          path: apiOperations["users.password.reset"].buildPath({ params: { userId: account.id } }),
          body: { password: "replacement-person-password" }
        }
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("resets a person's two-factor sign-in only after the dialog confirms, and never one's own", async () => {
    const mounted = await usersPage(["superadmin"], [{ ...account, twoFactorEnabled: true }]);
    try {
      await act(async () => rowButton("Managed person", "managed@example.test").click());
      await act(async () => button("Reset two-factor sign-in").click());
      const dialog = required(document.querySelector('dialog[open], [role="dialog"]'));
      expect(mounted.requests).toEqual([]);
      await act(async () => button("Reset", dialog).click());
      await vi.waitFor(() => expect(mounted.requests).toHaveLength(1), {
        timeout: CONDITION_WAIT_MS
      });
      expect(mounted.requests).toEqual([
        {
          method: "POST",
          path: apiOperations["users.two_factor.reset"].buildPath({
            params: { userId: account.id }
          }),
          body: undefined
        }
      ]);
    } finally {
      await mounted.unmount();
    }

    const own = await usersPage(
      ["superadmin"],
      [{ ...account, twoFactorEnabled: true }],
      account.id
    );
    try {
      await act(async () => rowButton("Managed person", "managed@example.test").click());
      expect(own.container.textContent).toContain("Delete user");
      expect(own.container.textContent).not.toContain("Reset two-factor sign-in");
    } finally {
      await own.unmount();
    }
  });

  it("requires the person's exact email before deleting and returns to the list without that person", async () => {
    const mounted = await usersPage(["superadmin"]);
    try {
      await act(async () => rowButton("Managed person", "managed@example.test").click());
      await act(async () => button("Delete user").click());
      const dialog = required(document.querySelector('dialog[open], [role="dialog"]'));
      const confirm = button("Permanently delete user", dialog);
      expect(confirm.disabled).toBe(true);
      await fill("Confirmation", "wrong user", dialog);
      expect(confirm.disabled).toBe(true);
      expect(mounted.requests).toEqual([]);
      await fill("Confirmation", "managed@example.test", dialog);
      expect(confirm.disabled).toBe(false);
      await act(async () => confirm.click());
      await waitForText(mounted.container, "Users");
      expect(mounted.requests).toEqual([
        {
          method: "DELETE",
          path: apiOperations["users.delete"].buildPath({ params: { userId: account.id } }),
          body: undefined
        }
      ]);
      expect(mounted.container.textContent).not.toContain("Managed person");
    } finally {
      await mounted.unmount();
    }
  });
});
