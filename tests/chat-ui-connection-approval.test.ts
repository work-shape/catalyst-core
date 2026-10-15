import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ConnectionApprovalList,
  pastedCandidates,
  readConnectionDraft,
  type ApprovalSurface
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

const INJECTION = '<img src=x onerror="alert(1)"> [click](javascript:alert(2))';
const LONG_VALUE = "A permitted report category with a detailed name. ".repeat(30);
// Each branch contains a separate set: selecting just one combinator branch would hide values.
const operation = {
  name: "reports",
  path: "/reports/{region}",
  pathParams: { region: { schema: { enum: ["north", "south"] } } },
  query: {
    category: { schema: { enum: ["overview", INJECTION, LONG_VALUE] } },
    nested: {
      schema: {
        anyOf: [
          { enum: ["any-first", "any-second"] },
          {
            oneOf: [
              { enum: ["one-first", "one-second"] },
              {
                allOf: [
                  { enum: ["all-first", "all-second"] },
                  { items: { enum: ["item-first", "item-second"] } }
                ]
              }
            ]
          }
        ],
        properties: { status: { enum: ["property-first", "property-second"] } },
        additionalProperties: { enum: ["additional-first", "additional-second"] },
        $defs: { kind: { enum: ["definition-first", "definition-second"] } }
      }
    }
  }
};

for (const source of ["pasted", "drafted"] as const) {
  describe(`${source} parameter enums in the approval list`, () => {
    it.each(["en", "de"] as const)(
      "shows every allowed value as folded plain text (%s)",
      (locale) => {
        const candidates = (() => {
          if (source === "pasted") {
            const read = pastedCandidates(`operations:\n  - ${JSON.stringify(operation)}`);
            if (!read.ok) throw new Error("Expected pasted declarations");
            return read.candidates;
          }
          const read = readConnectionDraft({
            output: {
              connection: { name: "reports", title: "Reports", baseUrl: "https://example.test" },
              operations: [operation]
            }
          });
          if (!read) throw new Error("Expected an agent draft");
          return read.operations;
        })();
        const markup = renderToStaticMarkup(
          createElement(
            TranslationProvider,
            { locale, children: null },
            createElement(ConnectionApprovalList, {
              candidates,
              declared: true,
              choice: {
                selected: new Set(["reports"]),
                surfaces: new Set<ApprovalSurface>(["agent"])
              },
              onSelectedChange: () => undefined,
              onSurfacesChange: () => undefined
            })
          )
        );
        expect(markup).toContain(locale === "en" ? "Allowed values" : "Erlaubte Werte");
        expect(markup).toContain(
          locale === "en" ? "Path parameter: region" : "Pfadparameter: region"
        );
        expect(markup).toContain(
          locale === "en" ? "Query parameter: category" : "Abfrageparameter: category"
        );
        for (const value of [
          "north",
          "south",
          "overview",
          LONG_VALUE,
          "any-first",
          "any-second",
          "one-first",
          "one-second",
          "all-first",
          "all-second",
          "item-first",
          "item-second",
          "property-first",
          "property-second",
          "additional-first",
          "additional-second",
          "definition-first",
          "definition-second"
        ]) {
          expect(markup).toContain(value);
        }
        expect(markup).toContain("&lt;img src=x onerror=");
        expect(markup).toContain("[click](javascript:alert(2))");
        expect(markup).not.toContain("<img");
        expect(markup).not.toContain("<a ");
        expect(markup.match(/data-approval-enum=/gu)).toHaveLength(9);
        // The actual rendered value uses FoldedText's three-line fold, not a raw text dump.
        expect(markup).toMatch(
          /data-approval-enum=""><span[^>]*class="[^"]*line-clamp-3[^"]*">[^<]*A permitted report category/u
        );
      }
    );
  });
}
