// @vitest-environment happy-dom
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MailPreview,
  RecipientField,
  TemplateText,
  TemplateTextField,
  UiRoot,
  normalizeTemplateParts,
  uiLabelsEn,
  type RecipientItem,
  type TemplatePart
} from "@work-shape/catalyst-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

async function mount(element: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element))
  );
  return host;
}

const fields = [{ heading: "Load", options: [{ value: "load#emails", label: "Addresses" }] }];

describe("normalizeTemplateParts", () => {
  it("drops empty text and joins text side by side", () => {
    expect(normalizeTemplateParts(["a", "", "b", { option: "x" }, "", "c", "d"])).toEqual([
      "ab",
      { option: "x" },
      "cd"
    ]);
  });
});

describe("TemplateTextField", () => {
  function Sample({ initial, seen }: { initial: TemplatePart[]; seen: TemplatePart[][] }) {
    const [value, setValue] = useState<readonly TemplatePart[]>(initial);
    return createElement(TemplateTextField, {
      label: "Subject",
      value,
      options: fields,
      onChange: (next: TemplatePart[]) => {
        seen.push(next);
        setValue(next);
      }
    });
  }

  it("draws a value of a step as a named chip, and reads typed text back with it", async () => {
    const seen: TemplatePart[][] = [];
    const node = await mount(
      createElement(Sample, { initial: ["Hello ", { option: "load#emails" }], seen })
    );
    const editor = node.querySelector<HTMLElement>("[data-template-editor]");
    if (!editor) throw new Error("no editor");
    expect(node.querySelector("label")?.getAttribute("for")).toBe(editor.id);
    expect(editor.querySelector("[data-template-option]")?.textContent).toBe("Addresses");
    await act(async () => {
      editor.append(document.createTextNode(" done"));
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(seen.at(-1)).toEqual(["Hello ", { option: "load#emails" }, " done"]);
  });

  it("shows the text read-only with its chips", async () => {
    const node = await mount(
      createElement(TemplateText, {
        value: ["Result ", { option: "load#emails" }],
        options: fields
      })
    );
    expect(node.textContent).toBe("Result Addresses");
  });
});

describe("RecipientField", () => {
  function Sample({ initial, pickedAlone }: { initial: RecipientItem[]; pickedAlone?: boolean }) {
    const [value, setValue] = useState<readonly RecipientItem[]>(initial);
    return createElement(RecipientField, {
      label: "To",
      value: value.map((item) =>
        item.value.endsWith("@outside.test") ? { ...item, invalid: "Not this domain." } : item
      ),
      onChange: setValue,
      fields,
      ...(pickedAlone === undefined ? {} : { pickedAlone })
    });
  }

  const chips = () =>
    [...(host?.querySelectorAll("[data-recipient]") ?? [])].map(
      (chip) =>
        `${chip.getAttribute("data-recipient")}:${chip.textContent?.replace(/^[^:]+: /u, "")}`
    );

  it("takes typed addresses on Enter and marks the ones the caller refuses", async () => {
    const node = await mount(createElement(Sample, { initial: [] }));
    const input = node.querySelector("input");
    if (!input) throw new Error("no input");
    expect(input.required).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "anna@example.test otto@outside.test"
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(chips()).toEqual(["address:anna@example.test", "address:otto@outside.test"]);
    expect(node.querySelector("[data-recipient-invalid]")?.textContent).toBe(
      "otto@outside.test: Not this domain."
    );
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    expect(chips()).toEqual(["address:anna@example.test"]);
  });

  it("holds a picked value alone: nothing more can be typed or added", async () => {
    const node = await mount(
      createElement(Sample, {
        initial: [{ kind: "picked", value: "load#emails", label: "Addresses" }],
        pickedAlone: true
      })
    );
    expect(chips()).toEqual(["picked:Addresses"]);
    expect(node.querySelector("input")).toBeNull();
    expect(node.textContent).toContain(uiLabelsEn.recipientPickedAlone);
  });
});

describe("MailPreview", () => {
  it("says the mail is empty before there is one", async () => {
    const node = await mount(createElement(MailPreview, { state: "empty", label: "Mail" }));
    expect(node.querySelector("[data-mail-preview]")?.getAttribute("data-mail-preview")).toBe(
      "empty"
    );
    expect(node.textContent).toBe(uiLabelsEn.mailEmpty);
  });

  it("draws a server body in a sandboxed frame that runs no script", async () => {
    const node = await mount(
      createElement(MailPreview, {
        label: "Mail",
        from: { name: "Instance", address: "office@example.test" },
        to: [{ label: "Miriam" }, { label: "Addresses", picked: true }],
        subject: "Report",
        html: "<p>Hello</p><script>parent.hacked = true</script>"
      })
    );
    const frame = node.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(node.querySelector('[data-mail-row="to"]')?.textContent).toContain("Miriam");
    expect(node.querySelector('[data-mail-recipient="picked"]')?.textContent).toBe("Addresses");
  });

  it("marks a test send and names whom it would have reached", async () => {
    const node = await mount(
      createElement(
        MailPreview,
        {
          label: "Mail",
          test: { to: [{ label: "Miriam" }] },
          to: [{ label: "Tester" }],
          subject: "Report"
        },
        "Body"
      )
    );
    expect(node.querySelector("[data-mail-preview]")?.getAttribute("data-mail-preview")).toBe(
      "test"
    );
    expect(node.querySelector('[data-mail-row="subject"]')?.textContent).toContain(
      uiLabelsEn.mailTestPrefix
    );
    expect(node.querySelector("[data-mail-test]")?.textContent).toContain("Miriam");
    expect(node.querySelector("[data-mail-body]")?.textContent).toBe("Body");
  });
});
