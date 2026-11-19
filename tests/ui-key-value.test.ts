import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KeyValue, KeyValueList } from "@work-shape/catalyst-ui";

// A row sets its label beside its value through the layout its list names: the list carries
// `data-layout`, and every row reads it with `group-data-[layout=inline]/key-value`.

function list(layout: "inline" | "stacked" | undefined, rowLayout?: "stacked"): string {
  return renderToStaticMarkup(
    createElement(
      KeyValueList,
      layout === undefined ? null : { layout },
      createElement(KeyValue, { label: "Owner", layout: rowLayout }, "Team")
    )
  );
}

describe("KeyValue", () => {
  it("names its layout on the list, inline by default", () => {
    expect(list(undefined)).toMatch(/^<dl data-layout="inline"/u);
    expect(list("stacked")).toMatch(/^<dl data-layout="stacked"/u);
  });

  it("sets a row beside its label in an inline list, and above it where the row stacks", () => {
    expect(list("inline")).toContain("group-data-[layout=inline]/key-value:grid-cols-");
    expect(list("inline", "stacked")).not.toContain(
      "group-data-[layout=inline]/key-value:grid-cols-"
    );
  });
});
