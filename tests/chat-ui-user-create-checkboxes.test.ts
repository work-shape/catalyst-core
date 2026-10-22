// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationProvider } from "./support/chat-ui/shared";
import { UserAdministrationPanel } from "@work-shape/catalyst-chat-ui/control-plane";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// Instance > Users > New user (UI-LIB-1): the two choices of how a new person signs in are the
// library's checkboxes, named by their labels, and a click on a label toggles its box. Space on
// a focused box is the browser's own button behaviour, checked in e2e/users-list.spec.ts.

let host: HTMLDivElement;
let root: Root;

const unused = async () => {
  throw new Error("not called");
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function openCreateForm() {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(UserAdministrationPanel, {
            users: [],
            loading: false,
            canManageSuperadminAccess: true,
            mutating: false,
            onCreateUser: unused,
            onUpdateUser: unused,
            onDeleteUser: unused,
            onUpsertIdentity: unused,
            onDeleteIdentity: unused,
            onResetPassword: unused,
            onSendInvitation: unused
          })
        )
      )
    )
  );
  const newUser = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "New user"
  );
  act(() => newUser?.click());
}

function checkbox(name: string): HTMLElement {
  const label = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === name
  );
  const box = label ? document.getElementById(label.htmlFor) : null;
  if (!label || !box) {
    throw new Error(`no checkbox named ${name}`);
  }
  return box;
}

const invite = "Email an invitation to set a password";
const passwordSignIn = "Create password sign-in";

describe("the sign-in choices of a new user", () => {
  it("are library checkboxes named by their labels", () => {
    openCreateForm();
    const box = checkbox(invite);
    expect(box.getAttribute("role")).toBe("checkbox");
    expect(box.tagName).toBe("BUTTON");
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(() => checkbox(passwordSignIn)).toThrow();
    expect(document.querySelector('input[type="checkbox"]:not([aria-hidden="true"])')).toBeNull();
  });

  it("toggle on a click on the box or on its label", () => {
    openCreateForm();
    act(() => checkbox(invite).click());
    expect(checkbox(invite).getAttribute("aria-checked")).toBe("false");
    // Without an invitation the password sign-in is offered, off until it is chosen.
    expect(checkbox(passwordSignIn).getAttribute("aria-checked")).toBe("false");

    const label = [...document.querySelectorAll("label")].find(
      (candidate) => candidate.textContent === passwordSignIn
    );
    act(() => label?.click());
    expect(checkbox(passwordSignIn).getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Initial password");

    act(() => checkbox(invite).click());
    expect(checkbox(invite).getAttribute("aria-checked")).toBe("true");
    expect(() => checkbox(passwordSignIn)).toThrow();
  });
});

describe("the advanced rights of a new user", () => {
  // They folded under a raw `details` element, outside the library and its focus ring.
  it("fold under the library's disclosure, closed until opened", () => {
    openCreateForm();
    expect(document.querySelector("details, summary")).toBeNull();
    const trigger = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Advanced rights"
    );
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("Tool rights");

    act(() => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Tool rights");
  });
});
