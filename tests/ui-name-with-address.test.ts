import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NameWithAddress, UiRoot, uiLabelsEn, type AddressCheck } from "@work-shape/catalyst-ui";

function render(check: AddressCheck, typedAddress?: string): string {
  return renderToStaticMarkup(
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsEn },
      createElement(NameWithAddress, {
        value: { name: "Support Desk", ...(typedAddress === undefined ? {} : { typedAddress }) },
        onChange: () => undefined,
        derive: (name: string) => name.toLowerCase().replaceAll(" ", "_"),
        check,
        nameLabel: "Name",
        addressLabel: "Address",
        addressHint: "It cannot be changed later.",
        advancedLabel: "Advanced"
      })
    )
  );
}

// UXA-2: the name first, the address folded under "Advanced" until something is wrong with it.
describe("NameWithAddress", () => {
  it("keeps the address folded while it is free, and opens it on a refused address", () => {
    expect(render({ state: "free" })).not.toContain('data-name-with-address-field="address"');

    const refused = render({ state: "refused", reason: "This address is taken." });
    expect(refused).toMatch(
      /<input[^>]*data-name-with-address-field="address"[^>]*value="support_desk"/u
    );
    expect(refused).toContain("This address is taken.");
    expect(render({ state: "refused", reason: "Taken." }, "desk")).toMatch(
      /data-name-with-address-field="address"[^>]*value="desk"/u
    );
  });
});
