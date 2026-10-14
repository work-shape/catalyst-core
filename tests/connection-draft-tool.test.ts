import { describe, expect, it } from "vitest";
import { createHttpApiConnectorType, HTTP_API_CONNECTOR_TYPE } from "@vivd-catalyst/connections";
import {
  asClientInstanceId,
  createConnectorTypeRegistry,
  isJsonObject,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import {
  CONNECTION_DRAFT_TOOL_NAME,
  createConnectionDraftTool
} from "@vivd-catalyst/tool-execution";

// The agent's draft of the tools of a REST API (CS-5c): the tool checks the declarations as a
// save would and answers the draft the card shows, or every issue and no card. The draft never
// carries a key, and the first cut's rules hold: GET only, the effect `reading`, no header or
// parameter that carries a credential, no value of its own in a schema, no dot segment in the
// path.

/** A text that stands for a key. No answer below may repeat it. */
const SECRET = "sk-live-4b3c2d1e0f9a";

const tool = createConnectionDraftTool({
  connectorTypes: createConnectorTypeRegistry([createHttpApiConnectorType()]),
  connectorType: HTTP_API_CONNECTOR_TYPE
});

function context(): ToolExecutionContext {
  const clientInstanceId = asClientInstanceId("connection-draft-client");
  return {
    clientInstanceId,
    correlationId: "corr_connection_draft",
    user: {
      id: "user-connection-draft",
      externalUserId: "user-connection-draft",
      displayLabel: "Draft User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

const listClients = {
  name: "list_clients",
  title: "Mandanten auflisten",
  description: "Lists the clients of the firm. Call it to find a client's id.",
  method: "GET",
  path: "/clients",
  query: { pageToken: { schema: { type: "string" }, description: "The next page." } },
  effect: "reading"
};

const fiscalYears = {
  name: "list_fiscal_years",
  description: "Lists the fiscal years of one client.",
  method: "GET",
  path: "/clients/{clientId}/fiscal-years",
  pathParams: { clientId: { schema: { type: "string" } } },
  effect: "reading"
};

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connection: "exampledata",
    title: "Exampledata",
    baseUrl: "https://api.exampledata.com",
    headerNames: ["x-client-instance-id"],
    operations: [listClients, fiscalYears],
    ...overrides
  };
}

/** Runs the tool as the runtime does: the input through its schema, the answer through its. */
async function run(input: Record<string, unknown>) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" as const, issues: parsed.error.issues };
  const result = await tool.execute(parsed.data, context());
  if (result.status === "success" && tool.outputSchema) {
    return { ...result, output: tool.outputSchema.parse(result.output) };
  }
  return result;
}

/** The issues of a refused draft, by the field of the input each is about. */
async function refusedPaths(input: Record<string, unknown>): Promise<string[]> {
  const result = await run(input);
  if (result.status !== "failed") throw new Error(`Expected a refusal, got ${result.status}`);
  expect(result.error.code).toBe("validation_failed");
  const details = result.error.details;
  const issues = isJsonObject(details) ? details.issues : undefined;
  if (!Array.isArray(issues)) throw new Error("A refusal names its issues");
  return issues.map((issue: unknown) =>
    typeof issue === "object" && issue !== null && "path" in issue ? String(issue.path) : ""
  );
}

describe("the agent's draft of REST API tools", () => {
  it("answers the checked draft the card shows: name, address, header names, declarations", async () => {
    expect(tool.name).toBe(CONNECTION_DRAFT_TOOL_NAME);
    expect(tool.effect).toBe("reading");
    const result = await run(draft());
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.output).toEqual({
      connection: {
        name: "exampledata",
        title: "Exampledata",
        baseUrl: "https://api.exampledata.com",
        headerNames: ["x-client-instance-id"]
      },
      operations: [
        {
          name: "list_clients",
          title: "Mandanten auflisten",
          description: listClients.description,
          method: "GET",
          path: "/clients",
          query: listClients.query,
          effect: "reading"
        },
        {
          name: "list_fiscal_years",
          description: fiscalYears.description,
          method: "GET",
          path: "/clients/{clientId}/fiscal-years",
          pathParams: fiscalYears.pathParams,
          effect: "reading"
        }
      ]
    });
  });

  it("never carries a key: header values, key fields and an address with a password stay out", async () => {
    const result = await run(
      draft({
        apiKey: SECRET,
        key: SECRET,
        headers: { "x-client-instance-id": SECRET },
        auth: { scheme: "bearer", token: SECRET },
        operations: [
          { ...listClients, headers: { Authorization: `Bearer ${SECRET}` }, secret: SECRET },
          fiscalYears
        ]
      })
    );
    expect(result.status).toBe("success");
    expect(JSON.stringify(result)).not.toContain(SECRET);

    // An address with a user and password is refused, and the refusal does not repeat it.
    const withUser = await run(draft({ baseUrl: `https://user:${SECRET}@api.exampledata.com` }));
    expect(withUser.status).toBe("failed");
    expect(JSON.stringify(withUser)).not.toContain(SECRET);

    // A key as a query value of the address is refused the same way.
    const withQuery = await run(draft({ baseUrl: `https://api.exampledata.com/?key=${SECRET}` }));
    expect(withQuery.status).toBe("failed");
    expect(JSON.stringify(withQuery)).not.toContain(SECRET);
  });

  it("refuses a method other than GET and the effect 'changing'", async () => {
    expect(
      await refusedPaths(draft({ operations: [{ ...listClients, method: "POST" }] }))
    ).toContain("operations.0.method");
    expect(
      await refusedPaths(draft({ operations: [{ ...listClients, effect: "changing" }] }))
    ).toContain("operations.0.effect");
  });

  it("refuses a header that can carry a credential, by its name", async () => {
    for (const name of ["Authorization", "X-Api-Key", "x-auth-token", "Cookie"]) {
      expect(await refusedPaths(draft({ headerNames: [name] }))).toContain("headerNames");
    }
  });

  it("refuses a parameter that can carry a credential by its words, and keeps a cursor", async () => {
    const withQuery = (name: string) =>
      draft({
        operations: [{ ...listClients, query: { [name]: { schema: { type: "string" } } } }]
      });
    const refused = [
      "api_key",
      "access_token",
      "key",
      "token",
      "client-secret",
      "subscription-key",
      "refresh_token",
      "id_token",
      "auth_key",
      "authkey",
      "user_key",
      "license_key",
      "jwt",
      "pwd",
      "Ocp-Apim-Subscription-Key",
      "APIKey",
      "sessionid",
      "password"
    ];
    for (const name of refused) {
      expect(await refusedPaths(withQuery(name)), name).toContain(`operations.0.query.${name}`);
    }
    for (const name of [
      "pageToken",
      "next_page_token",
      "nextToken",
      "secretary",
      "author",
      "sortKey"
    ]) {
      expect((await run(withQuery(name))).status, name).toBe("success");
    }
    expect(
      await refusedPaths(
        draft({
          operations: [
            {
              ...fiscalYears,
              path: "/keys/{apiKey}",
              pathParams: { apiKey: { schema: { type: "string" } } }
            }
          ]
        })
      )
    ).toContain("operations.0.pathParams.apiKey");
  });

  it("refuses a value of the draft's own in a parameter's schema: default, const, examples", async () => {
    for (const keyword of ["default", "const", "examples", "example"]) {
      const value = keyword === "examples" ? [SECRET] : SECRET;
      expect(
        await refusedPaths(
          draft({
            operations: [
              {
                ...listClients,
                query: { pageToken: { schema: { type: "string", [keyword]: value } } }
              }
            ]
          })
        ),
        keyword
      ).toContain(`operations.0.query.pageToken.schema.${keyword}`);
    }
    expect(
      await refusedPaths(
        draft({
          operations: [
            {
              ...fiscalYears,
              pathParams: {
                clientId: { schema: { anyOf: [{ type: "string", default: SECRET }] } }
              }
            }
          ]
        })
      )
    ).toContain("operations.0.pathParams.clientId.schema.anyOf.0.default");
  });

  it("refuses a '.' or '..' path segment in any spelling", async () => {
    for (const path of ["/clients/../admin", "/clients/./x", "/clients/%2e%2E/admin", "/%2E"]) {
      expect(await refusedPaths(draft({ operations: [{ ...listClients, path }] }))).toContain(
        "operations.0.path"
      );
    }
  });
});
