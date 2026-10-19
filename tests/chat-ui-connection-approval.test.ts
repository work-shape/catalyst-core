import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ConnectionApprovalList,
  discoveredCandidates,
  pastedCandidates,
  readConnectionDraft,
  type ApprovalSurface
} from "@work-shape/catalyst-chat-ui/build-area";
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

function renderList(
  props: Partial<Parameters<typeof ConnectionApprovalList>[0]> &
    Pick<Parameters<typeof ConnectionApprovalList>[0], "candidates">,
  locale: "en" | "de" = "en"
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale, children: null },
      createElement(ConnectionApprovalList, {
        choice: {
          selected: new Set(props.candidates.map((candidate) => candidate.name)),
          surfaces: new Set<ApprovalSurface>(["agent"])
        },
        onSelectedChange: () => undefined,
        onSurfacesChange: () => undefined,
        ...props
      })
    )
  );
}

/** The opening tag of a list row's own check box, by the row's tool. */
function rowCheckbox(markup: string, name: string): string {
  const row = markup.split(`data-approval-tool="${name}"`)[1] ?? "";
  return /<button[^>]*role="checkbox"[^>]*>/u.exec(row)?.[0] ?? "";
}

describe("pasted operations outside the reading cut (ACCEPT-FIX-7 C8)", () => {
  const read = pastedCandidates(`
- name: list_clients
  path: /clients
- name: create_client
  method: POST
  path: /clients
`);
  if (!read.ok) throw new Error("Expected pasted declarations");

  it.each([
    [
      "en",
      "This connection only reads: an operation that changes data or does not use GET cannot be approved. 1 operation cannot be selected."
    ],
    [
      "de",
      "Diese Verbindung liest nur: Eine Operation, die Daten ändert oder nicht GET nutzt, lässt sich nicht freigeben. 1 Operation ist nicht auswählbar."
    ]
  ] as const)("cannot be ticked, and the list says why once (%s)", (locale, reason) => {
    const markup = renderList({ candidates: read.candidates, declared: true }, locale);
    expect(rowCheckbox(markup, "create_client")).toMatch(/ disabled=""/u);
    expect(rowCheckbox(markup, "create_client")).toContain('aria-checked="false"');
    expect(rowCheckbox(markup, "list_clients")).not.toMatch(/ disabled=""/u);
    expect(markup.split(reason)).toHaveLength(2);
    expect(markup).not.toContain("first cut");
  });
});

describe("the effect of a discovered tool at approval (ACCEPT-FIX-7 C10)", () => {
  const candidates = discoveredCandidates([
    { name: "read_wiki", proposedEffect: "changing", fingerprint: "a".repeat(64) }
  ]);

  it.each(["en", "de"] as const)(
    "offers reads or changes per tool, starting with what the hint proposed (%s)",
    (locale) => {
      const markup = renderList({ candidates, onEffectsChange: () => undefined }, locale);
      const select = /<select[^>]*data-approval-effect="read_wiki"[^>]*>.*?<\/select>/su.exec(
        markup
      )?.[0];
      expect(select).toContain(
        locale === "en" ? 'aria-label="Effect of Read wiki"' : 'aria-label="Wirkung von Read wiki"'
      );
      expect(select).toMatch(/<option value="changing" selected="">/u);
      expect(select).toContain(locale === "en" ? ">reads<" : ">liest<");
      const chosen = renderList(
        {
          candidates,
          onEffectsChange: () => undefined,
          choice: {
            selected: new Set(["read_wiki"]),
            surfaces: new Set<ApprovalSurface>(["agent"]),
            effects: new Map([["read_wiki", "reading" as const]])
          }
        },
        locale
      );
      expect(chosen).toMatch(/<option value="reading" selected="">/u);
    }
  );

  it("offers no choice for a REST API's declarations, which only read", () => {
    const read = pastedCandidates("- name: list_clients\n  path: /clients");
    if (!read.ok) throw new Error("Expected pasted declarations");
    const markup = renderList({
      candidates: read.candidates,
      declared: true,
      onEffectsChange: () => undefined
    });
    expect(markup).not.toContain("data-approval-effect");
  });
});
