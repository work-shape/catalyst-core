import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_NAMES, platformModules } from "@vivd-catalyst/client-assembly";
import {
  createHttpApiConnectorType,
  HTTP_API_CONNECTOR_TYPE,
  isCredentialHeaderName
} from "@vivd-catalyst/connections";
import {
  asClientInstanceId,
  createConnectorTypeRegistry,
  createModuleRegistry,
  isJsonObject,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import {
  CONNECTION_DRAFT_TOOL_NAME,
  createConnectionDraftTool,
  ToolRegistry
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

  it("refuses a parameter that can carry a credential by its normalized name, with only exact harmless exceptions", async () => {
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
      "password",
      "aPiKeY",
      "rEfReSh_tOkEn",
      "pRiVaTeKeY",
      "sEsSiOnId",
      "pagePassword",
      "next_secret",
      "sortJwt",
      "pageAuth",
      "nextSignature",
      "x-pageToken",
      "pageTokenSuffix",
      "auth1key",
      "a-u-t-h",
      "s_e_s_s_i_o_n",
      "pa1ss2word",
      "pw3d",
      "X-Api-Key",
      "access-token",
      "client_secret",
      "passphrase",
      "passwd",
      "bearer",
      "signature",
      "syncToken",
      "cursorToken"
    ];
    for (const name of refused) {
      expect(await refusedPaths(withQuery(name)), name).toContain(`operations.0.query.${name}`);
    }
    for (const name of [
      "pageToken",
      "next_page_token",
      "nextToken",
      "continuationToken",
      "PaGe1_ToKeN",
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

  it("refuses a singleton enum at any schema depth, but keeps reviewable choices", async () => {
    const wrappers: ((schema: Record<string, unknown>) => Record<string, unknown>)[] = [
      (schema) => schema,
      (schema) => ({ anyOf: [schema] }),
      (schema) => ({ oneOf: [schema] }),
      (schema) => ({ allOf: [schema] }),
      (schema) => ({ items: schema }),
      (schema) => ({ properties: { nested: schema } }),
      (schema) => ({ additionalProperties: schema }),
      (schema) => ({ $defs: { hidden: schema } }),
      (schema) => ({ anyOf: [{ allOf: [{ items: schema }] }] })
    ];
    const withSchema = (schema: Record<string, unknown>) =>
      draft({ operations: [{ ...listClients, query: { state: { schema } } }] });
    for (const wrap of wrappers) {
      const result = await run(withSchema({ type: "string", ...wrap({ enum: [SECRET] }) }));
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).toContain("value_in_draft");
      expect(JSON.stringify(result)).not.toContain(SECRET);
      for (const keyword of ["default", "const", "examples", "example"]) {
        const value = keyword === "examples" ? [SECRET] : SECRET;
        const refused = await run(withSchema({ type: "string", ...wrap({ [keyword]: value }) }));
        expect(refused.status, keyword).toBe("failed");
        expect(JSON.stringify(refused)).toContain("value_in_draft");
        expect(JSON.stringify(refused)).not.toContain(SECRET);
      }
    }
    expect((await run(withSchema({ type: "string", enum: ["active", "archived"] }))).status).toBe(
      "success"
    );
  });

  it("refuses Unicode, encoded and space-padded parameter names", async () => {
    for (const name of [
      "ＡＰＩ_KEY",
      "ＡＰＩ_ＫＥＹ",
      "api%5Fkey",
      " api_key",
      "api_key ",
      "a\u200bpi_key"
    ]) {
      expect(
        (
          await run(
            draft({
              operations: [{ ...listClients, query: { [name]: { schema: { type: "string" } } } }]
            })
          )
        ).status,
        name
      ).toBe("failed");
    }
  });

  it("refuses a '.' or '..' path segment in any spelling", async () => {
    for (const path of ["/clients/../admin", "/clients/./x", "/clients/%2e%2E/admin", "/%2E"]) {
      expect(await refusedPaths(draft({ operations: [{ ...listClients, path }] }))).toContain(
        "operations.0.path"
      );
    }
  });
});

describe("where the draft tool is offered", () => {
  /** The release's registry with every module on, but `connections` as given. */
  const registryWith = (connections: boolean) =>
    new ToolRegistry({
      tools: [tool],
      enabledToolNames: new Set([CONNECTION_DRAFT_TOOL_NAME]),
      modules: createModuleRegistry(platformModules).snapshot(
        Object.fromEntries(
          platformModules.map((module) => [
            module.name,
            { enabled: module.name !== "connections" || connections }
          ])
        )
      )
    });

  it("is a tool of the module connections: off with it, on with it", () => {
    expect(registryWith(false).has(CONNECTION_DRAFT_TOOL_NAME)).toBe(false);
    expect(registryWith(true).has(CONNECTION_DRAFT_TOOL_NAME)).toBe(true);
  });

  it("is no tool every agent may hold whatever the modules: an agent lists it by name", () => {
    // Fixtures hand an agent every name of the list; with connections off, that agent would be
    // refused for naming a tool of a module that is off.
    expect(PLATFORM_TOOL_NAMES).not.toContain(CONNECTION_DRAFT_TOOL_NAME);
  });
});

describe("the unchanged fixed-header credential rule", () => {
  it("keeps main's case-insensitive substring rule, without the parameter exceptions or extras", () => {
    const mainWords = ["auth", "key", "token", "secret", "password", "session"];
    const mainRule = (name: string) =>
      mainWords.some((word) => name.toLowerCase().includes(word)) ||
      ["proxy-authorization", "cookie"].includes(name.toLowerCase());
    const names = [
      "author",
      "secretary",
      "sortKey",
      "pageToken",
      "jwt",
      "pwd",
      "passwd",
      "bearer",
      "signature",
      "Cookie",
      "COOKIE",
      "ＡＰＩ_KEY",
      "api%5Fkey",
      ...mainWords.flatMap((word) => [word, word.toUpperCase(), `x-${word}-value`, `${word}id`])
    ];
    for (const name of names) expect(isCredentialHeaderName(name), name).toBe(mainRule(name));
  });
});
