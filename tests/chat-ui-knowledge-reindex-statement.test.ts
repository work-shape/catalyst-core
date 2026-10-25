import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ReindexStatement } from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The statement before passages are embedded (KB-8): a first index adds one index, so a store
// without room for it says that, and only a re-index speaks of a second one beside the first.

const statement = {
  bindingId: "embed-eu",
  model: "text-embedding-3-large",
  chunks: 1_200,
  tokens: 480_000,
  room: false,
  storeBytes: 900_000_000,
  addedBytes: 200_000_000,
  limitBytes: 1_000_000_000,
  confirmation: "a".repeat(64)
};

function render(locale: "en" | "de", first: boolean): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(ReindexStatement, { statement, locale, first })
    })
  );
}

describe("the room a first index or a re-index needs", () => {
  it("names one index for a first embedding, in English and German", () => {
    expect(render("en", true)).toContain("no room for the embedded passages");
    expect(render("en", true)).not.toContain("both indexes");
    expect(render("de", true)).toContain("keinen Platz für die eingebetteten Passagen");
    expect(render("de", true)).not.toContain("beide Indexe");
  });

  it("names both indexes for a re-index beside the active one", () => {
    expect(render("en", false)).toContain("no room for both indexes");
    expect(render("de", false)).toContain("keinen Platz für beide Indexe");
  });
});
