// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionCreateFlow,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// Replaces e2e/connection-editor.spec.ts "cancel after a failed connect asks, then deletes the
// Connection": the failed connect has already written the Connection and stored its key, so
// closing the dialog asks first, and Discard deletes that Connection at the revision the
// dialog wrote. Nothing half-made, key and all, is left behind.

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Types into a field as React hears it. */
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string, within: ParentNode = document): HTMLButtonElement {
  return required(
    [...within.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text
    )
  );
}

describe("cancelling a new Connection after a failed connect", () => {
  it("asks, then deletes the Connection the connect wrote, once, at its revision", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writes: (number | null)[] = [];
    const secrets: string[] = [];
    const removed: { name: string; expectedRevision: number }[] = [];
    const closed: string[] = [];
    const source: ConnectionSource = {
      mayTest: () => true,
      useDetail: () => ({ status: "loading" }),
      readDetail: async () => connectionDetail("nowhere"),
      // The address answers nothing: the connect fails after the write and the key.
      test: async () => ({ status: "unavailable", testedAt: "2026-10-24T10:00:00.000Z" }),
      setSecret: async (_name, value) => {
        secrets.push(value);
      },
      discover: async () => undefined,
      useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
      useHolders: () => ({ status: "hidden" }),
      principalHref: () => "",
      oauthStart: async () => {
        throw new Error("This test signs nothing in.");
      }
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(ConnectionCreateFlow, {
              source,
              checkName: async () => ({ available: true as const }),
              put: async ({ expectedRevision }) => {
                writes.push(expectedRevision);
                return { revision: 7 };
              },
              remove: async (input) => {
                removed.push(input);
              },
              mayDelete: () => true,
              onClose: () => closed.push("closed"),
              onCreated: (name) => closed.push(`created ${name}`)
            })
          )
        )
      )
    );

    await act(async () =>
      required(
        document.querySelector<HTMLElement>('[data-connection-type="http_api"] button')
      ).click()
    );
    await type(
      required(document.querySelector<HTMLInputElement>('[data-name-with-address-field="name"]')),
      "Nowhere"
    );
    await type(
      required(document.querySelector<HTMLInputElement>('[data-connection-field="url"]')),
      "https://nowhere.example.test/nope"
    );
    await type(
      required(document.querySelector<HTMLInputElement>('input[type="password"]')),
      "sk-nowhere"
    );
    await act(async () =>
      required(document.querySelector<HTMLButtonElement>("[data-connection-connect]")).click()
    );
    await vi.waitFor(
      () =>
        expect(document.body.textContent).toContain(
          "No server answers at this address. Check it and connect again."
        ),
      { timeout: CONDITION_WAIT_MS }
    );
    // The failed connect wrote the Connection and stored its key.
    expect(writes).toEqual([null]);
    expect(secrets).toEqual(["sk-nowhere"]);

    await act(async () => button("Cancel").click());
    // Cancel asks first: the dialog has not closed.
    expect(closed).toEqual([]);
    const ask = await vi.waitFor(
      () =>
        required(
          [...document.querySelectorAll<HTMLElement>('[role="alertdialog"], dialog[open]')].find(
            (dialog) => dialog.textContent?.includes("Discard")
          )
        ),
      { timeout: CONDITION_WAIT_MS }
    );
    // Asking deletes nothing yet.
    expect(removed).toEqual([]);
    await act(async () => button("Discard", ask).click());

    await vi.waitFor(() => expect(closed).toEqual(["closed"]), { timeout: CONDITION_WAIT_MS });
    expect(removed).toEqual([{ name: "nowhere", expectedRevision: 7 }]);
  });
});
