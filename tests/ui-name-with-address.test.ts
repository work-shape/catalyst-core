import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NameWithAddress, UiRoot, uiLabelsEn, type AddressCheck } from "@vivd-catalyst/ui";

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

// UXA-2: the name first, the address folded under "Advanced". Fails without `NameWithAddress`.
describe("NameWithAddress", () => {
  it("asks for the name and keeps the address folded while nothing is wrong with it", () => {
    const markup = render({ state: "free" });

    expect(markup).toMatch(
      /<input[^>]*data-name-with-address-field="name"[^>]*value="Support Desk"/u
    );
    expect(markup).toMatch(/data-name-with-address-fold=""[^>]*>(?:<[^>]+>)*Advanced/u);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('data-name-with-address-field="address"');
  });

  it("opens the fold on a refused address and names the reason at the address", () => {
    const markup = render({ state: "refused", reason: "This address is taken." });

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toMatch(
      /<input[^>]*data-name-with-address-field="address"[^>]*data-address-check="refused"[^>]*value="support_desk"/u
    );
    expect(markup).toMatch(/<p[^>]*role="alert"[^>]*>This address is taken\.<\/p>/u);
    expect(markup).not.toContain("It cannot be changed later.");
  });

  it("shows the address as typed once somebody typed one", () => {
    expect(render({ state: "refused", reason: "Taken." }, "desk")).toMatch(
      /data-name-with-address-field="address"[^>]*value="desk"/u
    );
  });
});
