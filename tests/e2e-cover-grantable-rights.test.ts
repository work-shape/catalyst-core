// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { EffectivePermissions } from "@work-shape/catalyst-api-client";
import { grantOptions } from "@work-shape/catalyst-chat-ui/access";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
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

import { required } from "./support/assertions";
