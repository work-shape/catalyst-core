import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  AssetPreviewCardView,
  assetPreviewSurfaceAfterRunCalls,
  previewedDraftOfCall
} from "@work-shape/catalyst-chat-ui/pages";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The draft of an asset whose kind brings a preview, such as a form page, opens beside the
// chat when the agent saves it (EW-9c2): the answer of `platform.assets.put` says `preview`,
// the thread shows a card, and the run's newest such save opens the surface once.

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const created = {
  output: {
    saved: true,
    revision: 1,
    created: true,
    kind: "form_page",
    name: "firm-look",
    title: "Our forms",
    preview: true
  }
};
const savedAgain = {
  output: { saved: true, revision: 2, kind: "form_page", name: "firm-look", preview: true }
};

describe("a save with a preview", () => {
  it("is read from the answer of platform.assets.put that says preview, and from no other", () => {
    expect(previewedDraftOfCall({ toolName: "platform.assets.put", result: created })).toEqual({
      kind: "form_page",
      name: "firm-look",
      title: "Our forms",
      revision: 1
    });
    // A later save names no title: the card names the asset.
    expect(previewedDraftOfCall({ toolName: "platform.assets.put", result: savedAgain })).toEqual({
      kind: "form_page",
      name: "firm-look",
      title: "firm-look",
      revision: 2
    });
    const without = { output: { ...created.output, preview: undefined } };
    expect(previewedDraftOfCall({ toolName: "platform.assets.put", result: without })).toBe(
      undefined
    );
    expect(previewedDraftOfCall({ toolName: "workspace.open", result: created })).toBe(undefined);
    expect(
      previewedDraftOfCall({ toolName: "platform.assets.put", result: created, isError: true })
    ).toBe(undefined);
  });

  it("opens the newest save of a run beside the chat, once per call", () => {
    const call = (toolCallId: string, output: unknown, state = "output_available") => ({
      type: "tool_call",
      toolCallId,
      toolName: "platform.assets.put",
      state,
      output
    });
    const handled = new Set<string>();
    const ask = (parts: ReturnType<typeof call>[]) =>
      assetPreviewSurfaceAfterRunCalls({ conversationId: "conv-1", parts, handled });

    expect(ask([call("c-1", created, "input_available")])).toBeUndefined();
    expect(ask([call("c-1", created), call("c-2", savedAgain)])).toEqual({
      kind: "asset_preview",
      key: "asset-preview:form_page:firm-look:2",
      title: "firm-look",
      conversationId: "conv-1",
      assetKind: "form_page",
      name: "firm-look",
      revision: 2
    });
    expect(ask([call("c-1", created), call("c-2", savedAgain)])).toBeUndefined();
  });

  it("shows a card that opens the draft, in German first", () => {
    const draft = { kind: "form_page", name: "firm-look", title: "Our forms", revision: 1 };
    const de = render(
      createElement(AssetPreviewCardView, { draft, shown: false, onOpen: () => {} }),
      "de"
    );
    expect(de).toContain("Our forms");
    expect(de).toContain("Entwurf gespeichert");
    expect(de).toContain("Vorschau");
    const shown = render(createElement(AssetPreviewCardView, { draft, shown: true }));
    expect(shown).toContain("Draft saved");
    expect(shown).not.toContain("<button");
  });
});
