import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceMark, serviceInitial } from "@work-shape/catalyst-ui";

// The mark of an outside service: the official logo, unchanged, where its owner permits it,
// and otherwise the white initial on the service's colour. The library draws no vendor's logo.

describe("ServiceMark", () => {
  const render = (props: Parameters<typeof ServiceMark>[0]) =>
    renderToStaticMarkup(createElement(ServiceMark, props));

  it("shows the white initial on the service's colour, with the name beside it", () => {
    const markup = render({ name: "Ledger", color: "#2f6f4f" });
    expect(markup).toContain('data-service-mark-tile="initial"');
    expect(markup).toContain("background-color:#2f6f4f;color:#ffffff");
    expect(markup).toMatch(/aria-hidden="true"[^>]*>L<\/span>/u);
    expect(markup).toContain(">Ledger</span>");
  });

  it("draws a supplied logo unchanged, and nothing of its own", () => {
    const logo = "data:image/svg+xml;base64,PHN2Zy8+";
    const markup = render({ name: "Files", logo, showName: false });
    expect(markup).toContain('data-service-mark-tile="logo"');
    expect(markup).toContain(`src="${logo}"`);
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("Files");
  });

  it("falls back to a neutral tile without a colour", () => {
    const markup = render({ name: "Other", size: "sm" });
    expect(markup).toContain('data-service-mark-tile="neutral"');
    expect(markup).toMatch(/\bbg-secondary\b/u);
  });

  it("takes the first letter or digit of the name", () => {
    expect(serviceInitial("  exampledata")).toBe("E");
    expect(serviceInitial("ödland")).toBe("Ö");
    expect(serviceInitial("(1&1)")).toBe("1");
    expect(serviceInitial("—")).toBe("");
  });
});
