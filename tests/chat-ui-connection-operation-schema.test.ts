import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ConnectionOperationDetail, LocaleCode } from "@work-shape/catalyst-api-client";
import {
  httpOperationDeclaration,
  mcpOperationDeclaration,
  OperationDetails,
  PARAMETERS_MAX,
  RAW_MAX_CHARS,
  TEXT_MAX_CHARS,
  VALUES_MAX
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// CONN-PAGE 1: every accepted operation says what it calls and what it takes. A REST API's
// operation is read from the definition the page holds, without a request; an MCP tool from
// the input schema its server named. Both come from outside the instance: wrong shapes are
// passed over, sizes are bounded, and every text is shown as text.

/** A REST API's definition with one declared operation, as the approval writes it. */
const restConfig = {
  name: "exampledata",
  connectorType: "http_api",
  settings: { baseUrl: "https://api.exampledata.com" },
  operations: [
    {
      name: "listFiscalYears",
      effect: "reading",
      exposure: ["agent"],
      enabled: true,
      method: "get",
      path: "/clients/{clientId}/fiscal-years",
      pathParams: {
        clientId: { schema: { type: "string", format: "uuid" }, description: "The client." }
      },
      query: {
        status: { schema: { type: "string", enum: ["open", "closed"] }, required: false },
        limit: { schema: { type: "integer", minimum: 1, maximum: 100 }, required: true },
        fields: { schema: { type: "array", items: { type: "string", enum: ["id", "year"] } } }
      }
    }
  ]
};

const mcpSchema = {
  type: "object",
  required: ["year", "filter"],
  properties: {
    year: { type: "integer", minimum: 2000, description: "The year to sum up." },
    currency: { anyOf: [{ type: "string" }, { type: "null" }], default: "EUR" },
    tags: { type: "array", items: { type: "string" }, maxItems: 5 },
    filter: {
      type: "object",
      required: ["region"],
      properties: { region: { enum: ["north", "south"] }, city: { type: "string" } }
    }
  }
};

function operation(overrides: Partial<ConnectionOperationDetail> = {}): ConnectionOperationDetail {
  return {
    name: "revenue_by_month",
    toolName: "connection.sample.revenue_by_month",
    effect: "reading",
    exposure: ["agent"],
    enabled: true,
    status: "ready",
    ...overrides
  };
}

function render(
  config: Record<string, unknown>,
  detail: ConnectionOperationDetail,
  locale: LocaleCode = "en"
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale, children: null },
      createElement(OperationDetails, { operation: detail, config })
    )
  );
}

describe("What a REST API's operation sends", () => {
  it("reads the method, the path and every parameter from the definition", () => {
    const declaration = httpOperationDeclaration(restConfig, "listFiscalYears");
    expect(declaration?.request).toEqual({
      method: "GET",
      path: "/clients/{clientId}/fiscal-years"
    });
    expect(
      declaration?.parameters.map((parameter) => [parameter.name, parameter.location])
    ).toEqual([
      ["clientId", "path"],
      ["status", "query"],
      ["limit", "query"],
      ["fields", "query"]
    ]);
    const [clientId, status, limit, fields] = declaration?.parameters ?? [];
    // A path parameter is always required; a query parameter where it says so.
    expect(clientId?.required).toBe(true);
    expect(clientId?.description).toBe("The client.");
    expect(status?.required).toBe(false);
    expect(status?.values).toEqual(["open", "closed"]);
    expect(limit?.required).toBe(true);
    expect(limit?.constraints).toEqual([
      { key: "minimum", value: "1" },
      { key: "maximum", value: "100" }
    ]);
    // A list's allowed entries are its items' values, apart from the values of the list itself.
    expect(fields?.values).toEqual([]);
    expect(fields?.itemValues).toEqual(["id", "year"]);
    expect(declaration?.raw).toContain('"pathParams"');
    // The approval's own members are not part of what the operation sends.
    expect(declaration?.raw).not.toContain("exposure");
    expect(httpOperationDeclaration(restConfig, "missing")).toBeUndefined();
  });

  it("shows the request and the parameters in words, in English and German", () => {
    const markup = render(restConfig, operation({ name: "listFiscalYears" }));
    expect(markup).toContain(">Request<");
    expect(markup).toContain("GET /clients/{clientId}/fiscal-years");
    expect(markup).toContain('data-connection-parameter="clientId"');
    expect(markup).toContain(">In the path<");
    expect(markup).toContain(">Required<");
    expect(markup).toContain(">Whole number<");
    expect(markup).toContain("Allowed values: open or closed");
    expect(markup).toContain("At least 1 · At most 100");
    expect(markup).toContain("Format: uuid");
    expect(markup).toContain(">List (Text)<");
    expect(markup).toContain("Allowed entries: id or year");
    expect(markup).toContain('data-connection-declaration="listFiscalYears"');
    const german = render(restConfig, operation({ name: "listFiscalYears" }), "de");
    expect(german).toContain(">Anfrage<");
    expect(german).toContain(">Im Pfad<");
    expect(german).toContain(">In der Abfrage<");
    expect(german).toContain(">Pflicht<");
    expect(german).toContain(">Ganze Zahl<");
    expect(german).toContain("Erlaubte Werte: open oder closed");
    expect(german).toContain("Mindestens 1 · Höchstens 100");
    expect(german).toContain("Erlaubte Einträge: id oder year");
  });
});

describe("What an MCP tool takes", () => {
  it("lists the members of its input schema with types, required, values and constraints", () => {
    const declaration = mcpOperationDeclaration(mcpSchema);
    expect(declaration?.request).toBeUndefined();
    expect(
      declaration?.parameters.map((parameter) => [parameter.name, parameter.required])
    ).toEqual([
      ["year", true],
      ["currency", false],
      ["tags", false],
      ["filter", true],
      ["filter.region", true],
      ["filter.city", false]
    ]);
    const byName = new Map(declaration?.parameters.map((parameter) => [parameter.name, parameter]));
    expect(byName.get("currency")?.types).toEqual(["string", "null"]);
    expect(byName.get("tags")?.itemTypes).toEqual(["string"]);
    // A type the schema leaves out is read from the values it allows.
    expect(byName.get("filter.region")?.types).toEqual(["string"]);
    expect(byName.get("filter.region")?.values).toEqual(["north", "south"]);
  });

  it("shows the tool and its inputs, the schema under Technical details", () => {
    const markup = render(
      { connectorType: "mcp" },
      operation({ inputSchema: mcpSchema, description: "Sums up revenue." })
    );
    expect(markup).toContain(">Tool on the server<");
    expect(markup).toContain(">revenue_by_month<");
    expect(markup).toContain(">Text or Empty<");
    expect(markup).toContain(">List (Text)<");
    expect(markup).toContain(">Group of values<");
    expect(markup).toContain("Default: EUR");
    expect(markup).toContain("At most 5 entries");
    expect(markup).toContain(">Technical details<");
    for (const nothing of [
      { type: "object", properties: {}, additionalProperties: false },
      { type: "object", additionalProperties: false }
    ]) {
      expect(render({ connectorType: "mcp" }, operation({ inputSchema: nothing }))).toContain(
        "Takes no input."
      );
    }
    expect(render({ connectorType: "mcp" }, operation())).toContain(
      "What this tool takes is not shown: the server described no input, or its description is too large."
    );
    expect(render({ connectorType: "mcp" }, operation(), "de")).toContain(
      "Was dieses Tool braucht, wird nicht gezeigt"
    );
  });
});

describe("An input schema the page does not list member by member", () => {
  it("never says the tool takes nothing, and points to Technical details", () => {
    for (const schema of [
      { type: "object" },
      { type: "object", additionalProperties: true },
      // An empty `properties` is open to any member unless the object is closed.
      { type: "object", properties: {} },
      { type: "object", properties: {}, additionalProperties: true },
      { type: "object", properties: {}, required: ["query"], additionalProperties: false },
      { allOf: [{ $ref: "#/$defs/query" }] },
      { oneOf: [{ type: "object" }, { type: "object" }] },
      { $ref: "#/$defs/input", additionalProperties: false },
      { type: "object", patternProperties: { "^x-": { type: "string" } } }
    ]) {
      expect(mcpOperationDeclaration(schema)?.takesNothing, JSON.stringify(schema)).toBe(false);
      const markup = render({ connectorType: "mcp" }, operation({ inputSchema: schema }));
      expect(markup).not.toContain("Takes no input.");
      expect(markup).toContain("data-connection-inputs-elsewhere");
      expect(markup).toContain(
        "Its inputs are written in a form this page does not list. See Technical details."
      );
    }
    expect(
      render({ connectorType: "mcp" }, operation({ inputSchema: { allOf: [] } }), "de")
    ).toContain("Siehe Technische Details.");
  });
});

describe("A declaration of the wrong shape or size", () => {
  it("passes over members of the wrong shape and never throws", () => {
    for (const schema of [null, "text", 3, [], { properties: "x" }, { properties: [1, 2] }]) {
      const read = mcpOperationDeclaration(schema);
      expect(read?.parameters ?? []).toEqual([]);
    }
    const strange = mcpOperationDeclaration({
      properties: {
        a: null,
        b: { type: 7, enum: "x", minimum: { nested: true }, anyOf: "no" },
        c: { type: ["string", 5, null] }
      },
      required: "a"
    });
    expect(strange?.parameters.map((parameter) => parameter.name)).toEqual(["a", "b", "c"]);
    expect(strange?.parameters.every((parameter) => !parameter.required)).toBe(true);
    expect(strange?.parameters[1]?.types).toEqual([]);
    expect(strange?.parameters[2]?.types).toEqual(["string"]);
    const rest = httpOperationDeclaration(
      {
        operations: [
          "nope",
          { name: "odd", method: 4, path: null, pathParams: [1], query: { q: "text" } }
        ]
      },
      "odd"
    );
    expect(rest?.request).toEqual({ method: "GET", path: "" });
    expect(rest?.parameters.map((parameter) => parameter.name)).toEqual(["q"]);
  });

  it("lists a bounded number of parameters and values, and cuts long texts", () => {
    const properties = Object.fromEntries(
      Array.from({ length: PARAMETERS_MAX + 30 }, (_, index) => [
        `field_${index}`,
        {
          type: "string",
          description: "x".repeat(TEXT_MAX_CHARS * 3),
          enum: Array.from({ length: VALUES_MAX + 50 }, (_, value) => `v${value}`)
        }
      ])
    );
    const read = mcpOperationDeclaration({ type: "object", properties });
    expect(read?.parameters).toHaveLength(PARAMETERS_MAX);
    expect(read?.moreParameters).toBe(true);
    expect(read?.parameters[0]?.values).toHaveLength(VALUES_MAX);
    expect(read?.parameters[0]?.moreValues).toBe(true);
    expect(read?.parameters[0]?.description?.length).toBe(TEXT_MAX_CHARS);
    expect(read?.raw.length).toBeLessThanOrEqual(RAW_MAX_CHARS);
    // Within the bound the declaration under Technical details is whole, valid JSON.
    expect(read?.rawCut).toBe(false);
    expect(JSON.parse(read?.raw ?? "")).toEqual({ type: "object", properties });
    const over = mcpOperationDeclaration({ description: "x".repeat(RAW_MAX_CHARS) });
    expect(over?.rawCut).toBe(true);
    expect(over?.raw.length).toBe(RAW_MAX_CHARS);
    const markup = render({ connectorType: "mcp" }, operation({ inputSchema: { properties } }));
    expect(markup).toContain("It takes more inputs. All of them are under Technical details.");
    expect(markup).toContain("and more");
  });

  it("shows a text of the server as text, never as markup", () => {
    const markup = render(
      { connectorType: "mcp" },
      operation({
        inputSchema: {
          properties: {
            "<img src=x onerror=alert(1)>": {
              type: "string",
              description: "<script>alert(1)</script>",
              enum: ["<b>bold</b>"]
            }
          }
        }
      })
    );
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img src=x");
    expect(markup).not.toContain("<b>bold</b>");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
