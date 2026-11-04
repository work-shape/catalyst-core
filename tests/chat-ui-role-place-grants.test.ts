// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { EffectivePermissions, Role } from "@work-shape/catalyst-api-client";
import { RolePage, withPlaceGrants, type RoleEditor } from "@work-shape/catalyst-chat-ui/access";
import { ROLE_DEFAULT_ACTIONS } from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";
import { TranslationProvider } from "./support/chat-ui/shared";

// A custom role holds rights in one place, as a person does: its page adds a right on one agent
// or skill with the Rights tab's dialog, and the role holds it beside its rights everywhere.

const allow = (action: string) => ({
  action,
  effect: "allow" as const,
  scopeKind: "instance" as const
});

const adminRights: EffectivePermissions = {
  holderActive: true,
  items: ROLE_DEFAULT_ACTIONS.admin.map((action) => ({
    ...allow(action),
    source: "role" as const,
    roleId: "admin"
  }))
};
const admin: RoleEditor = { superadmin: false, rights: adminRights };

const editorial: Role = {
  id: "role_editorial",
  name: "Editorial",
  builtIn: false,
  editable: true,
  grants: [allow("usage.view")],
  pendingActions: []
};

const agents = {
  failed: false,
  items: [
    {
      id: "agent-news",
      name: "Newsroom",
      resource: { kind: "agent", name: "newsroom", assetId: "agent-news" }
    },
    {
      id: "agent-other",
      name: "Other helper",
      resource: { kind: "agent", name: "other", assetId: "agent-other" }
    }
  ]
};

const label = (node: Element) =>
  document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent;
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

async function mounted(element: ReactElement, check: () => Promise<void>): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
    await act(async () => vi.runOnlyPendingTimersAsync());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

function page(role: Role, editor: RoleEditor, onUpdate: (...args: unknown[]) => Promise<unknown>) {
  return createElement(RolePage, {
    role,
    editor,
    names: { workspace: () => undefined, asset: () => undefined },
    onBack: () => undefined,
    onRename: () => undefined,
    onDelete: () => undefined,
    onUpdate,
    onReset: async () => undefined,
    onDecide: async () => undefined,
    grantSource: {
      assets: [],
      assetsFailure: undefined,
      kindAssets: { agent: agents, skill: { failed: false, items: [] } }
    }
  });
}

describe("a role's right in one place", () => {
  it("adds Publish on one agent to the role, keeping what it held", async () => {
    const onUpdate = vi.fn(async () => undefined);
    await mounted(page(editorial, admin, onUpdate), async () => {
      // Only an area whose kind has an asset to pick offers to add one.
      expect(buttonNamed("Add a right for Agents")).toBeDefined();
      expect(buttonNamed("Add a right for Skills")).toBeUndefined();
      await act(async () => required(buttonNamed("Add a right for Agents")).click());
      expect(document.body.textContent).toContain("New right in Editorial");
      // The holder is the role, and the kind is the area's: neither is asked.
      expect(buttonNamed("Person")).toBeUndefined();
      expect(
        [...document.querySelectorAll('[role="radiogroup"]')].map((group) => label(group))
      ).not.toContain("Kind");
      await act(async () => radioNamed("Publish").click());
      await act(async () => required(buttonNamed("Asset:")).click());
      await act(async () => optionNamed("Newsroom").click());
      await act(async () => vi.runOnlyPendingTimersAsync());
      await act(async () => required(buttonNamed("Create right")).click());
      expect(onUpdate).toHaveBeenCalledWith("role_editorial", {
        grants: [
          allow("usage.view"),
          ...["agent.read", "agent.use", "agent.write", "agent.publish"].map((action) => ({
            action,
            effect: "allow",
            scopeKind: "asset",
            scopeId: "agent-news"
          }))
        ]
      });
    });
  });

  it("offers no adding to who cannot change the role", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const reader: RoleEditor = { superadmin: false, rights: { holderActive: true, items: [] } };
    await mounted(page(editorial, reader, onUpdate), async () => {
      expect(buttonNamed("Add a right for Agents")).toBeUndefined();
    });
  });
});

describe("the role's grants with a right in one place", () => {
  const onAgent = (action: string, effect: "allow" | "deny" = "allow") => ({
    action,
    effect,
    scopeKind: "asset" as const,
    scopeId: "agent-news"
  });

  it("adds new rows, counts the ones held, and lets a row replace its opposite in that place", () => {
    const held = [allow("usage.view"), onAgent("agent.read"), onAgent("agent.write", "deny")];
    expect(
      withPlaceGrants(held, [onAgent("agent.read"), onAgent("agent.write"), onAgent("agent.use")])
    ).toEqual({
      grants: [
        allow("usage.view"),
        onAgent("agent.read"),
        onAgent("agent.write"),
        onAgent("agent.use")
      ],
      added: 2,
      existing: 1
    });
  });
});
