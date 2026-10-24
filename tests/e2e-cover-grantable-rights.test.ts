// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  AdministeredUser,
  CreatePermissionGrantRequest,
  EffectivePermissions
} from "@work-shape/catalyst-api-client";
import { grantOptions, GrantsTab } from "@work-shape/catalyst-chat-ui/access";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";
import { GrantDialog } from "./support/chat-ui";
import { TranslationProvider } from "./support/chat-ui/shared";

const assets = {
  app: {
    failed: false,
    items: [
      {
        id: "app-a",
        name: "Held App",
        resource: { kind: "app", name: "app-a", assetId: "app-a", workspaceId: "w-a" }
      },
      {
        id: "app-b",
        name: "Unheld App",
        resource: { kind: "app", name: "app-b", assetId: "app-b", workspaceId: "w-b" }
      }
    ]
  }
};
const workspaces = {
  failed: false,
  items: [
    { id: "w-a", name: "Held workspace" },
    { id: "w-b", name: "Unheld workspace" }
  ]
};
const label = (node: Element) =>
  document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent;

it.each(["asset", "workspace"] as const)(
  "renders only held verbs and places for an %s giver",
  async (scopeKind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rights: EffectivePermissions = {
      holderActive: true,
      items: (scopeKind === "asset" ? ["app.read"] : ["app.read", "app.write"]).map((action) => ({
        action,
        effect: "allow",
        scopeKind,
        scopeId: scopeKind === "asset" ? "app-a" : "w-a",
        source: "grant"
      }))
    };
    const onGrant = vi.fn(async () => ({ added: 0, existing: 0 }));
    const button = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
        node.getAttribute("aria-label")?.startsWith(name)
      );
    try {
      await act(async () =>
        root.render(
          createElement(TranslationProvider, {
            locale: "en",
            children: createElement(
              UiRoot,
              { mode: "light", labels: uiLabelsEn },
              createElement(GrantDialog, {
                users: [],
                usersFailed: false,
                assets: [],
                assetsFailure: undefined,
                kindAssets: assets,
                options: grantOptions(rights, assets, workspaces),
                workspaces,
                onGrant,
                onClose: () => undefined
              })
            )
          })
        )
      );
      const groups = [...document.querySelectorAll('[role="radiogroup"]')];
      const levels = groups.find((group) => label(group) === "Level");
      expect(levels).toBeDefined();
      expect([...required(levels).querySelectorAll('[role="radio"]')].map(label)).toEqual(
        scopeKind === "asset" ? ["View"] : ["View", "Edit"]
      );
      const where = groups.find((group) => label(group) === "Where");
      if (scopeKind === "asset") expect(where).toBeUndefined();
      else
        expect([...required(where).querySelectorAll('[role="radio"]')].map(label)).toEqual([
          "In a shared workspace",
          "On one App"
        ]);
      const picker = button(scopeKind === "asset" ? "App:" : "Workspace:");
      expect(picker).toBeDefined();
      await act(async () => picker?.click());
      expect(
        [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent)
      ).toEqual([scopeKind === "asset" ? "Held App" : "Held workspace"]);
      expect(onGrant).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);

/** Mounts `element` in English, runs `check`, and unmounts. */
async function mounted(element: ReactElement, check: () => Promise<void>): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(TranslationProvider, {
          locale: "en",
          children: createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
        })
      )
    );
    await check();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
}

const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name || node.getAttribute("aria-label")?.startsWith(name)
  );
const radioNamed = (name: string) =>
  required(
    [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (node) => label(node) === name
    )
  );
const optionNamed = (name: string) =>
  required(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === name
    )
  );

// Replaces e2e/grantable-rights.spec.ts "a giver with users.manage alone cannot open a new-right
// dialog": a giver who holds no right to give, though the instance has Apps and workspaces to
// give rights on, finds New right disabled.
it("disables New right for a giver who holds no right to give", async () => {
  const onGrant = vi.fn(async () => ({ added: 0, existing: 0 }));
  await mounted(
    createElement(GrantsTab, {
      giver: { holderActive: true, items: [] },
      grants: [],
      loadFailed: false,
      onRetry: () => undefined,
      users: [],
      usersFailed: false,
      assets: [],
      assetsFailure: undefined,
      kindAssets: assets,
      workspaces,
      onGrant,
      onRevoke: async () => undefined
    }),
    async () => {
      expect(required(buttonNamed("New right")).disabled).toBe(true);
      expect(onGrant).not.toHaveBeenCalled();
    }
  );
});

// Replaces e2e/grantable-rights.spec.ts "the new-right dialog offers only the giver's workspace
// verbs and places" (its write): Edit brings View with it, so Create right writes both rows,
// View first, for the chosen person in the chosen workspace.
it("writes View and Edit, View first, when a workspace giver grants Edit", async () => {
  const recipient: AdministeredUser = {
    id: "user-r",
    clientInstanceId: "client-1",
    displayLabel: "Rita Recipient",
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    status: "active",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    identities: []
  };
  const rights: EffectivePermissions = {
    holderActive: true,
    items: ["app.read", "app.write"].map((action) => ({
      action,
      effect: "allow",
      scopeKind: "workspace",
      scopeId: "w-a",
      source: "grant"
    }))
  };
  const written: (readonly CreatePermissionGrantRequest[])[] = [];
  const onGrant = vi.fn(async (requests: readonly CreatePermissionGrantRequest[]) => {
    written.push(requests);
    return { added: requests.length, existing: 0 };
  });
  await mounted(
    createElement(GrantDialog, {
      users: [recipient],
      usersFailed: false,
      assets: [],
      assetsFailure: undefined,
      kindAssets: assets,
      options: grantOptions(rights, assets, workspaces),
      workspaces,
      onGrant,
      onClose: () => undefined
    }),
    async () => {
      await act(async () => required(buttonNamed("Person")).click());
      await act(async () => optionNamed("Rita Recipient").click());
      await act(async () => radioNamed("In a shared workspace").click());
      await act(async () => required(buttonNamed("Workspace:")).click());
      await act(async () => optionNamed("Held workspace").click());
      await act(async () => radioNamed("Edit").click());
      await act(async () => required(buttonNamed("Create right")).click());
      expect(written).toEqual([
        [
          expect.objectContaining({
            holderKind: "user",
            holderId: "user-r",
            action: "app.read",
            effect: "allow",
            scopeKind: "workspace",
            scopeId: "w-a"
          }),
          expect.objectContaining({
            holderKind: "user",
            holderId: "user-r",
            action: "app.write",
            effect: "allow",
            scopeKind: "workspace",
            scopeId: "w-a"
          })
        ]
      ]);
    }
  );
});
