// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ServicePrincipalDetail } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { afterEach, expect, it, vi } from "vitest";
import { TranslationProvider } from "./chat-ui-render-harness";
import { required, waitUntil } from "./support/assertions";
import { ApiAccessPanel } from "./support/chat-ui";

// SP-RIGHTS-BUG: a principal created with "View configuration" was stored with the right, but
// the page then showed the first principal of the list it had before the save, which held none.

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function principal(
  id: string,
  displayLabel: string,
  permissions: ServicePrincipalDetail["principal"]["permissions"]
): ServicePrincipalDetail {
  return {
    principal: {
      id,
      clientInstanceId: "client-1",
      name: id,
      displayLabel,
      status: "active",
      permissionRefs: [],
      permissions,
      createdAt: "2026-10-25T10:00:00Z",
      updatedAt: "2026-10-25T10:00:00Z"
    },
    credentials: []
  };
}

function button(text: string): HTMLButtonElement {
  return required(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text
    )
  );
}

/** The heading of the principal the page shows on the right. */
function shownPrincipal(): string | undefined {
  const selected = document.querySelector('button[aria-current="page"]');
  return selected?.querySelector("span span")?.textContent ?? undefined;
}

it("shows the principal just created, with its rights, before the list is read again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rightless = principal("sp_first", "A first, no rights", []);
  const created = principal("sp_reader", "Reader", ["config_assets.read"]);
  const sent: unknown[] = [];
  const props: ComponentProps<typeof ApiAccessPanel> = {
    may: { principals: true, keys: true },
    principals: [rightless],
    loading: false,
    mutating: false,
    onCreatePrincipal: async (input) => {
      sent.push(input);
      return created;
    },
    onUpdatePrincipal: async () => created,
    onCreateCredential: async () => {
      throw new Error("not called");
    },
    onRevokeCredential: async () => {
      throw new Error("not called");
    },
    onClearRevealedCredential: () => undefined
  };
  const render = (input: ComponentProps<typeof ApiAccessPanel>) =>
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsEn },
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(ApiAccessPanel, input)
      })
    );
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root?.render(render(props)));
  expect(shownPrincipal()).toBe("A first, no rights");

  await act(async () => button("Create service principal").click());
  const name = required(document.querySelector<HTMLInputElement>("dialog input"));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "Reader");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  await waitUntil(() => !document.querySelector("dialog"), "the dialog closes");

  expect(sent).toEqual([
    { displayLabel: "Reader", status: "active", permissions: ["config_assets.read"] }
  ]);
  // The list is not read again yet: it still holds only the principal without rights. The
  // detail names its principal by `name`, which the list does not show.
  const detail = () => document.body.textContent ?? "";
  expect(detail()).toContain("sp_reader");
  expect(detail()).not.toContain("sp_first");
  expect(detail()).toContain("View configuration");
  expect(detail()).not.toContain("No configuration rights");

  // Read again, the list holds it, and it stays the one shown.
  await act(async () => root?.render(render({ ...props, principals: [rightless, created] })));
  expect(shownPrincipal()).toBe("Reader");
  expect(detail()).toContain("sp_reader");
  expect(detail()).not.toContain("No configuration rights");
});
