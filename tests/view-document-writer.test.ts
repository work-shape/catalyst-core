// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { privateRowImages } from "./fixtures/private-view-images";
import { composeViewDocument, viewRuntimeAddress } from "./support/chat-ui/chat-views";

// These inputs are plain image tags; use the existing DOM environment, without the empty-tree
// stub in view-html-parser.ts. Foreign-content and parser-mutation cases remain in Chromium.
// Chromium's parser round-trip, CSS and connection counters stay in view-exits.spec.ts.
describe("the private-row document writer", () => {
  it("keeps an image only when it is a raster image held in its address", () => {
    const there = "https://other.example.test";
    const { html, refused, kept, png } = privateRowImages(there);

    const composed = composeViewDocument({
      html,
      kind: "private_hydrated_view",
      runtime: viewRuntimeAddress("", "https://chat.example.test/"),
      allowedScriptSrc: []
    });
    const view = new DOMParser().parseFromString(composed, "text/html");
    expect(composed).not.toContain(new URL(there).host);
    expect(composed.toLowerCase()).not.toContain("svg");
    expect(composed).not.toContain("blob:null");
    expect(composed).not.toContain("text/html");
    expect(view.querySelectorAll("img.refused")).toHaveLength(refused.length);
    expect(view.querySelectorAll("img.refused[src]")).toHaveLength(0);
    expect(view.querySelectorAll("img.kept")).toHaveLength(kept.length);
    expect(view.querySelectorAll("img.kept[src]")).toHaveLength(kept.length);
    expect(view.querySelector("img.kept")?.getAttribute("src")).toBe(
      `data:image/png;base64,${png}`
    );
  });
});
