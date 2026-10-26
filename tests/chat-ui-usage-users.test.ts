// @vitest-environment happy-dom

import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient, type AdministeredUser } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { ROLE_DEFAULT_ACTIONS } from "@work-shape/catalyst-core";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  waitForText
} from "./chat-ui-settings-fixtures";

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
  it("shows Being deleted on the affected account's row", async () => {
    const mounted = await usersPage(["superadmin"], [{ ...account, status: "deleting" }]);
    try {
      const row = required(
        [...mounted.container.querySelectorAll("tbody tr")].find((item) =>
          item.textContent?.includes(account.email ?? "missing")
        )
      );
      expect(row.textContent).toContain("Being deleted");
    } finally {
      await mounted.unmount();
    }
  });

  it("lets an admin create a user without offering the superadmin role", async () => {
    const mounted = await usersPage(["user", "admin"]);
    try {
      await act(async () => button("New user").click());
      const dialog = required(document.querySelector('dialog[open], [role="dialog"]'));
      expect(dialog.textContent).toContain("New user");
      const roleLabel = required(
        [...dialog.querySelectorAll("label")].find(
          (item) => item.querySelector("span")?.textContent === "Role"
        )
      );
      const select = required(roleLabel.querySelector("select"));
      expect(select.querySelector('option[value="superadmin"]')).toBeNull();
      expect(select.querySelector('option[value="admin"]')?.textContent).toBe("Admin");
      await fill("Display label", "Created person", dialog);
      await fill("Email", "created@example.test", dialog);
      await fill("Initial password", "created-person-password", dialog);
      await act(async () => button("Create user", dialog).click());
      await vi.waitFor(
        async () => {
          await act(async () => {
            const created = [...document.querySelectorAll('dialog, [role="dialog"]')].find(
              (item) => {
                const title = document.getElementById(item.getAttribute("aria-labelledby") ?? "");
                return title?.textContent === "User created";
              }
            );
            expect(created).toBeDefined();
          });
        },
        { timeout: CONDITION_WAIT_MS }
      );
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
      await act(async () => button("Open user").click());
      await waitForText(mounted.container, "Created person");
      await waitForText(mounted.container, "Sign-in methods");
    } finally {
      await mounted.unmount();
    }
  });

  it("resets a person's password through their detail and reports Password updated", async () => {
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

  it("resets a person's two-factor sign-in after the dialog asks who is asking, and never one's own", async () => {
    const mounted = await usersPage(["superadmin"], [{ ...account, twoFactorEnabled: true }]);
    try {
      await act(async () => rowButton("Managed person", "managed@example.test").click());
      expect(mounted.container.textContent).toContain("Two-factor sign-in");
      await act(async () => button("Reset two-factor sign-in").click());
      const dialog = required(document.querySelector('dialog[open], [role="dialog"]'));
      expect(dialog.textContent).toContain("Reset two-factor sign-in of Managed person?");
      expect(dialog.textContent).toContain("outside this instance");
      expect(mounted.requests).toEqual([]);
      await act(async () => button("Reset", dialog).click());
      await waitForText(mounted.container, "sets up two-factor sign-in again");
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
      expect(dialog.textContent).toContain("Delete Managed person?");
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
      expect(mounted.container.querySelector("h1")?.textContent).toBe("Users");
      expect(mounted.container.textContent).not.toContain("Managed person");
    } finally {
      await mounted.unmount();
    }
  });
});
