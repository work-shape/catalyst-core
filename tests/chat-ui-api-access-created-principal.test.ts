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

function panelProps(
  principals: ServicePrincipalDetail[],
  onCreatePrincipal: ComponentProps<typeof ApiAccessPanel>["onCreatePrincipal"]
): ComponentProps<typeof ApiAccessPanel> {
  return {
    may: { principals: true, keys: true },
    principals,
    loading: false,
    mutating: false,
    onCreatePrincipal,
    onUpdatePrincipal: async () => {
      throw new Error("not called");
    },
    onCreateCredential: async () => {
      throw new Error("not called");
    },
    onRevokeCredential: async () => {
      throw new Error("not called");
    },
    onClearRevealedCredential: () => undefined
  };
}

function panel(input: ComponentProps<typeof ApiAccessPanel>) {
  return createElement(
    UiRoot,
    { mode: "light", labels: uiLabelsEn },
    createElement(TranslationProvider, {
      locale: "en",
      children: createElement(ApiAccessPanel, input)
    })
  );
}

async function renderPanel(input: ComponentProps<typeof ApiAccessPanel>): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root?.render(panel(input)));
}

/** Opens the create dialog, names the principal and saves, the default right left ticked. */
async function createNamed(label: string): Promise<void> {
  await act(async () => button("Create service principal").click());
  const name = required(document.querySelector<HTMLInputElement>("dialog input"));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, label);
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
}

it("shows the principal just created, with its rights, before the list is read again", async () => {
  const rightless = principal("sp_first", "A first, no rights", []);
  const created = principal("sp_reader", "Reader", ["config_assets.read"]);
  const sent: unknown[] = [];
  const props = panelProps([rightless], async (input) => {
    sent.push(input);
    return created;
  });
  await renderPanel(props);
  expect(shownPrincipal()).toBe("A first, no rights");

  await createNamed("Reader");
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
  await act(async () => root?.render(panel({ ...props, principals: [rightless, created] })));
  expect(shownPrincipal()).toBe("Reader");
  expect(detail()).toContain("sp_reader");
  expect(detail()).not.toContain("No configuration rights");
});

it("says a refused create in its dialog, which stays open with what was entered", async () => {
  const refusal = "This call does not hold 'config_assets.read' on the whole instance";
  await renderPanel(
    panelProps([principal("sp_first", "A first, no rights", [])], async () => {
      throw new Error(refusal);
    })
  );

  await createNamed("Reader");
  await waitUntil(
    () => document.querySelector("dialog")?.textContent?.includes(refusal) ?? false,
    "the dialog says the refusal"
  );
  const dialog = required(document.querySelector("dialog"));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(refusal);
  expect(required(dialog.querySelector<HTMLInputElement>("input")).value).toBe("Reader");
  // Said once, in the dialog, and not on the page behind it.
  expect(document.body.textContent?.split(refusal)).toHaveLength(2);

  // Closed, the dialog takes its refusal with it.
  await act(async () => button("Cancel").click());
  await waitUntil(() => !document.querySelector("dialog"), "the dialog closes");
  expect(document.body.textContent).not.toContain(refusal);
});
