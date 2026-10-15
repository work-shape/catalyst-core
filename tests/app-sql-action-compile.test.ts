import { describe, expect, it } from "vitest";
import {
  appActionInputAsZod,
  bindSqlActionParameters,
  compiledActionsOf,
  declaredDataStoresOf,
  type CompiledAppAction,
  type PageBuildResult
} from "@work-shape/catalyst-app-build";
import { buildPage, builtPageManifestSchema } from "@work-shape/catalyst-app-build/build";
import { POSTGRES_QUERY_TEXT_MAX_CHARS } from "@work-shape/catalyst-postgres-connector";
import { pageFiles } from "./support/page-build";

// The statement files of a Page as the build compiles them: the header into the parameters a
// call may pass, every `$name` into the position the database binds a value to, and the whole
// into the manifest. Every test here fails without the change: before it the build refused a
// manifest with `dataStores` and an action that names a `.sql` file.

const page = (
  manifest: Record<string, unknown>,
  files: Record<string, string | Uint8Array>
): Promise<PageBuildResult> =>
  buildPage({
    files: pageFiles({
      "app.yaml": JSON.stringify({
        id: "findings",
        name: "Findings",
        kit: "1.1.0",
        entry: "index.html",
        ...manifest
      }),
      "index.html": "<!doctype html><title>Findings</title><p>Findings</p>",
      ...files
    })
  });

const store = { dataStores: [{ name: "findings", minSchema: 1 }] };
const listed = (name = "list") => ({
  ...store,
  actions: [{ name, file: `actions/${name}.sql`, effect: "reading" }]
});

/** The one action of a Page that holds the statement `text` as `actions/list.sql`. */
async function compiled(
  text: string
): Promise<Extract<CompiledAppAction, { kind: "sql"; effect: "reading" }>> {
  const built = await page(listed(), { "actions/list.sql": text });
  if (built.status !== "built") throw new Error(JSON.stringify(built.errors));
  const [action] = compiledActionsOf(built.manifest);
  if (action?.kind !== "sql" || action.effect !== "reading") {
    throw new Error("The build compiled no reading sql action");
  }
  return action;
}

const errorsOf = async (result: Promise<PageBuildResult>) => {
  const built = await result;
  if (built.status !== "errors") throw new Error("The Page built");
  return built.errors.map(({ file, code, line, message }) => ({ file, code, line, message }));
};
const faultsOf = (text: string) => errorsOf(page(listed(), { "actions/list.sql": text }));

describe("the statement files of a Page", () => {
  it("reserves the scope parameter for SCOPE-1/2 in reading and changing actions", async () => {
    for (const effect of ["reading", "changing"]) {
      const statement =
        effect === "reading"
          ? "select $scope from findings"
          : "insert into findings (mandant_nr) values ($scope)";
      expect(
        await errorsOf(
          page(
            { ...store, actions: [{ name: "list", file: "actions/list.sql", effect }] },
            { "actions/list.sql": `-- @param scope text\n${statement}` }
          )
        )
      ).toEqual([
        {
          file: "actions/list.sql",
          code: "action_invalid",
          line: 1,
          message: expect.stringMatching(/'scope' is reserved.*SCOPE-1\/2/u)
        }
      ]);
    }
  });

  it.each(["scope", "scope_all"])(
    "refuses $viewer.%s with the later slice named, even when viewer is declared",
    async (name) => {
      // Declaring viewer defeats the old undeclared-parameter error. Removing the new
      // guard then builds this statement, so the test proves the reservation itself.
      expect(
        await faultsOf(`-- @param viewer text\nselect $viewer.${name}('mandant') from findings`)
      ).toEqual([
        {
          file: "actions/list.sql",
          code: "action_invalid",
          line: 2,
          message: expect.stringMatching(
            new RegExp(`'\\$viewer\\.${name}' is reserved.*SCOPE-1.*SCOPE-2`, "u")
          )
        }
      ]);
    }
  );

  it("refuses the dropped $viewer.groups instead of compiling it as a caller parameter", async () => {
    expect(await faultsOf("-- @param viewer text\nselect $viewer.groups from findings")).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: 2,
        message: expect.stringMatching(/'\$viewer\.groups' was dropped by SCOPE-0.*SCOPE-1/u)
      }
    ]);
  });

  it("keeps scope names in SQL text, comments and identifiers, and permits ordinary Mandant parameters", async () => {
    const action = await compiled(
      [
        "-- @param mandant_nr text",
        "-- @param viewer text",
        "-- @param scope_key text optional",
        "select '$viewer.scope', '$viewer.scope_all', '$viewer.groups',",
        '  "$viewer.scope" as quoted, amount$viewer.scope as identifier,',
        "  $$ $viewer.scope_all $$ as literal, $tag$ $viewer.groups $tag$ as tagged,",
        "  $viewer.scope_extra, $viewer.scope_all_extra, $viewer.groups_extra, $scope_key",
        "from findings -- $viewer.scope('mandant')",
        "/* $viewer.scope_all('mandant') and $viewer.groups */",
        "where mandant_nr = $mandant_nr"
      ].join("\n")
    );
    expect(action.parameters.map(({ name }) => name)).toEqual([
      "mandant_nr",
      "viewer",
      "scope_key"
    ]);
    expect(action.statement).toContain("where mandant_nr = $1");
    expect(action.statement).toContain("$2.scope_extra");
  });

  it("are compiled into the manifest with positions for names, and no statement file is a file of the built Page", async () => {
    const built = await page(listed("list_findings"), {
      "actions/list_findings.sql": [
        "-- The findings of one client, newest first.",
        "-- @param client text",
        "-- @param severity text optional",
        "-- @param limit integer",
        "",
        "select rule_id, severity, amount from findings",
        "where client_id = $client and ($severity is null or severity = $severity)",
        "order by id desc limit $limit",
        ""
      ].join("\n")
    });
    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));

    expect(built.manifest.actions).toEqual([
      {
        name: "list_findings",
        kind: "sql",
        file: "actions/list_findings.sql",
        effect: "reading",
        dataStore: "findings",
        statement: [
          "select rule_id, severity, amount from findings",
          "where client_id = $1 and ($2 is null or severity = $2)",
          "order by id desc limit $3"
        ].join("\n"),
        parameters: [
          { name: "client", type: "text" },
          { name: "severity", type: "text" },
          { name: "limit", type: "integer" }
        ],
        input: {
          schema: {
            type: "object",
            properties: {
              client: { type: "string" },
              severity: { type: "string" },
              limit: { type: "integer" }
            },
            required: ["client", "limit"]
          }
        }
      }
    ]);
    expect(built.files.map((file) => file.path)).toEqual(["index.html"]);
    // What a call and a publish read is the stored manifest.
    expect(declaredDataStoresOf(built.manifest)).toEqual([{ name: "findings", minSchema: 1 }]);
    expect(declaredDataStoresOf({ dataStores: "findings" })).toEqual([]);
  });

  it("gives every parameter type its place in the input and its type at the database", async () => {
    const action = await compiled(
      [
        "-- @param a text",
        "-- @param b integer",
        "-- @param c number",
        "-- @param d boolean",
        "-- @param e date",
        "-- @param f timestamp",
        "-- @param g text[]",
        "-- @param h date[] optional",
        "select $a, $b, $c, $d, $e, $f, $g, $h"
      ].join("\n")
    );

    expect(action.statement).toBe("select $1, $2, $3, $4, $5, $6, $7, $8");
    expect(action.input.schema).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "integer" },
        c: { type: "number" },
        d: { type: "boolean" },
        e: { type: "string", format: "date" },
        f: { type: "string", format: "date-time" },
        g: { type: "array", items: { type: "string" } },
        h: { type: "array", items: { type: "string", format: "date" } }
      },
      required: ["a", "b", "c", "d", "e", "f", "g"]
    });
    const input = {
      a: "x",
      b: 2,
      c: 2.5,
      d: true,
      e: "2026-09-30",
      f: "2026-09-30T12:00:00Z",
      g: ["x", "y"]
    };
    const read = appActionInputAsZod(action.input.schema);
    // A value keeps its declared type on its way to the database, and one that was left out
    // is bound as no value of that type.
    expect(bindSqlActionParameters(action.parameters, read.parse(input))).toEqual([
      { type: "text", value: "x" },
      { type: "integer", value: 2 },
      { type: "number", value: 2.5 },
      { type: "boolean", value: true },
      { type: "date", value: "2026-09-30" },
      { type: "timestamp", value: "2026-09-30T12:00:00Z" },
      { type: "text[]", value: ["x", "y"] },
      { type: "date[]", value: null }
    ]);
    for (const wrong of [
      { ...input, a: 1 },
      { ...input, b: 2.5 },
      { ...input, d: "true" },
      { ...input, e: "30.09.2026" },
      { ...input, f: "yesterday" },
      { ...input, g: "x" },
      { ...input, h: ["2026-09-30", "soon"] },
      { ...input, further: 1 },
      { ...input, a: undefined }
    ]) {
      expect(read.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });

  it("reads a name as a parameter only where the database would read a value", async () => {
    const action = await compiled(
      [
        "-- @param client text",
        "select '$client' as literal, 'it''s $client' as doubled, E'a\\'$client' as escaped,",
        '  "$client" as quoted, amount$client as part_of_a_name, -- $client in a comment',
        "  /* $client in a block /* and a nested $client */ still $client */",
        "  $$ $client in a dollar-quoted text $$ as bare, $tag$ $client $$ $tag$ as tagged",
        "from findings where client_id = $client and note <> $client::text"
      ].join("\n")
    );

    expect(action.statement).toBe(
      [
        "select '$client' as literal, 'it''s $client' as doubled, E'a\\'$client' as escaped,",
        '  "$client" as quoted, amount$client as part_of_a_name, -- $client in a comment',
        "  /* $client in a block /* and a nested $client */ still $client */",
        "  $$ $client in a dollar-quoted text $$ as bare, $tag$ $client $$ $tag$ as tagged",
        "from findings where client_id = $1 and note <> $1::text"
      ].join("\n")
    );
    expect(action.parameters).toEqual([{ name: "client", type: "text" }]);
  });

  it("refuses a name the header does not declare, a declared name the statement never uses, and a position", async () => {
    expect(await faultsOf("-- @param client text\nselect $client, $severity")).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: 2,
        message: expect.stringContaining("names '$severity', which the header does not declare")
      }
    ]);
    // A name that stands only inside a string is no use of the parameter.
    expect(
      await faultsOf("-- @param client text\n-- @param severity text\nselect $client, '$severity'")
    ).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: 2,
        message: expect.stringContaining("'severity' is declared and the statement never names")
      }
    ]);
    expect(await faultsOf("select * from findings where client_id = $1")).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: 1,
        message: expect.stringContaining("A parameter is named, as '$name'")
      }
    ]);
  });

  it("refuses a header line it cannot read, with its line", async () => {
    const cases: [string, string][] = [
      ["-- @param client varchar\nselect $client", "has the type 'varchar'"],
      ["-- @param 1st text\nselect 1", "cannot be the name of a parameter"],
      ["-- @param client text required\nselect $client", "holds more than a name, a type"],
      ["-- @param client text\n-- @param client text\nselect $client", "is declared twice"],
      ["-- @returns rows\nselect 1", "'@returns' is no line of a header"],
      ["-- @param client text\n", "holds no statement"],
      ["select 'open", "A string of the statement never ends"],
      ["select 1 /* open", "A comment of the statement never ends"],
      ["select $body$ open", "The text that starts with $body$ never ends"]
    ];
    for (const [text, message] of cases) {
      expect(await faultsOf(text), text).toEqual([
        {
          file: "actions/list.sql",
          code: "action_invalid",
          line: expect.any(Number),
          message: expect.stringContaining(message)
        }
      ]);
    }
  });

  it("refuses a file that is too large before it reads it, and compiles the largest file into a statement a Data Store takes", async () => {
    // Not UTF-8: a build that decoded the file before it measured it would say so instead.
    const oversized = new Uint8Array(12 * 1024 + 1).fill(0xff);
    expect(await errorsOf(page(listed(), { "actions/list.sql": oversized }))).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: undefined,
        message:
          "The statement file has 12289 bytes. It has at most 12288 (APP_SQL_ACTION_FILE_MAX_BYTES)."
      }
    ]);
    // The file that grows most when it is compiled: every name gives way to a longer position.
    const header = "abcdefghij"
      .split("")
      .map((name) => `-- @param ${name} text\n`)
      .join("");
    const names = "select $a,$b,$c,$d,$e,$f,$g,$h,$i";
    const largest = `${header}${names}${",$j".repeat((12 * 1024 - header.length - names.length) / 3)}`;
    expect(largest.length).toBeGreaterThan(12 * 1024 - 3);
    expect((await compiled(largest)).statement.length).toBeLessThanOrEqual(
      POSTGRES_QUERY_TEXT_MAX_CHARS
    );
    expect(
      await errorsOf(page(listed(), { "actions/list.sql": new Uint8Array([0x73, 0xff]) }))
    ).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: undefined,
        message: "The statement file is not UTF-8 text."
      }
    ]);
  });

  it("refuses what an sql action cannot be yet, each with the reason", async () => {
    const files = { "actions/list.sql": "select 1" };
    const withAction = (
      action: Record<string, unknown>,
      manifest: Record<string, unknown> = store
    ) =>
      errorsOf(
        page(
          { ...manifest, actions: [{ name: "list", file: "actions/list.sql", ...action }] },
          files
        )
      );

    expect(await withAction({ effect: "reading", connection: "warehouse" })).toEqual([
      {
        file: "app.yaml",
        code: "sql_target_not_available",
        line: undefined,
        message: expect.stringContaining("names the Connection 'warehouse'")
      }
    ]);
    expect(await withAction({ effect: "reading" }, {})).toEqual([
      {
        file: "app.yaml",
        code: "data_store_not_declared",
        line: undefined,
        message: expect.stringContaining("the manifest lists no Data Store")
      }
    ]);
    expect(
      await withAction(
        { effect: "reading" },
        { dataStores: [{ name: "findings" }, { name: "clients" }] }
      )
    ).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        line: undefined,
        message: expect.stringContaining("An action cannot name its Data Store yet")
      }
    ]);
    expect(await withAction({ effect: "reading", policy: "allow" })).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        line: undefined,
        message: expect.stringContaining("the policy 'allow'")
      }
    ]);
    expect(await withAction({ effect: "reading", cache: { ttl: 60 } })).toEqual([
      {
        file: "app.yaml",
        code: "cache_not_available",
        line: undefined,
        message: expect.stringContaining("asks for a cache")
      }
    ]);
  });

  it("compiles a changing statement into the row the store's insert is told, and writes no statement for it", async () => {
    const built = await page(
      { ...store, actions: [{ name: "add", file: "actions/add.sql", effect: "changing" }] },
      {
        "actions/add.sql": [
          "-- @param client text",
          "-- @param amount number optional",
          "-- @param found date",
          "-- Adds one finding.",
          'INSERT INTO public.findings (client_id, "Amount", found_on) /* in this order */',
          "values ($client, $amount, $found) on conflict do nothing;"
        ].join("\n")
      }
    );
    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));

    expect(built.manifest.actions).toEqual([
      {
        name: "add",
        kind: "sql",
        file: "actions/add.sql",
        effect: "changing",
        dataStore: "findings",
        insert: {
          table: "findings",
          columns: [
            { column: "client_id", parameter: "client" },
            { column: "Amount", parameter: "amount" },
            { column: "found_on", parameter: "found" }
          ],
          onConflict: "skip"
        },
        parameters: [
          { name: "client", type: "text" },
          { name: "amount", type: "number" },
          { name: "found", type: "date" }
        ],
        input: {
          schema: {
            type: "object",
            properties: {
              client: { type: "string" },
              amount: { type: "number" },
              found: { type: "string", format: "date" }
            },
            required: ["client", "found"]
          }
        }
      }
    ]);
  });

  it("refuses a statement that is not one read, or not the one insert a changing action may be, with a code of its own", async () => {
    const refused = (effect: string, text: string) =>
      errorsOf(
        page(
          { ...store, actions: [{ name: "list", file: "actions/list.sql", effect }] },
          { "actions/list.sql": text }
        )
      );
    const notAllowed = (message: string) => [
      {
        file: "actions/list.sql",
        code: "sql_statement_not_allowed",
        line: expect.any(Number),
        message: expect.stringContaining(message)
      }
    ];

    for (const text of [
      "delete from findings",
      "insert into findings (client_id) values ('a')",
      "select 1; select 2",
      "select 1; drop table findings",
      "-- @param a text\nupdate findings set client_id = $a",
      "/* select */ truncate findings"
    ]) {
      expect(await refused("reading", text), text).toEqual(
        notAllowed("A reading action is one SELECT or WITH statement")
      );
    }
    // A semicolon inside a string or a comment ends nothing.
    expect((await compiled("select ';' as mark -- one; statement\nfrom findings;")).statement).toBe(
      "select ';' as mark -- one; statement\nfrom findings;"
    );
    for (const text of [
      "select 1",
      "-- @param a text\nupdate findings set client_id = $a",
      "-- @param a text\ndelete from findings where client_id = $a",
      "-- @param a text\ninsert into findings (client_id) values ($a), ($a)",
      "-- @param a text\ninsert into findings (client_id) values (upper($a))",
      "insert into findings (client_id) values ('fixed')",
      "-- @param a text\ninsert into findings (client_id) select $a",
      "-- @param a text\ninsert into findings (client_id) values ($a); delete from findings",
      "-- @param a text\ninsert into other.findings (client_id) values ($a)",
      "-- @param a text\ninsert into findings (client_id) values ($a) returning *"
    ]) {
      expect(await refused("changing", text), text).toEqual(
        notAllowed("A changing action is one INSERT of one row whose values are parameters")
      );
    }
    expect(
      await refused(
        "changing",
        "-- @param a text\n-- @param b text\ninsert into findings (client_id) values ($a, $b)"
      )
    ).toEqual(notAllowed("names 1 columns and gives 2 values"));
    expect(
      await refused(
        "changing",
        "-- @param a text\n-- @param b text\ninsert into findings (x, X) values ($a, $b)"
      )
    ).toEqual(notAllowed("names the column 'x' twice"));
  });

  it("holds the statement files against the manifest: each has one line there, and a name is one action", async () => {
    // The manifest says what a statement does. A file without a line there is no action.
    expect(await errorsOf(page(store, { "actions/list.sql": "select 1" }))).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: undefined,
        message: expect.stringContaining("no line under 'actions'")
      }
    ]);
    expect(await errorsOf(page(listed(), {}))).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        line: undefined,
        message: expect.stringContaining("'actions/list.sql', which is not a file of the Page")
      }
    ]);
    expect(
      await errorsOf(
        page(
          { ...listed(), connections: ["crm"] },
          {
            "actions/list.sql": "select 1",
            "actions/list.action.yaml": "connection: crm\noperation: list\neffect: reading\n"
          }
        )
      )
    ).toEqual([
      {
        file: "actions/list.sql",
        code: "action_invalid",
        line: undefined,
        message: expect.stringContaining("Two files define the action 'list'")
      }
    ]);
    expect(
      await errorsOf(page({ dataStores: [{ name: "findings" }, { name: "findings" }] }, {}))
    ).toEqual([
      {
        file: "app.yaml",
        code: "manifest_invalid",
        line: undefined,
        message: expect.stringContaining("lists the Data Store 'findings' twice")
      }
    ]);
  });

  it("reads no built manifest whose action reaches a store or a Connection the manifest does not list", async () => {
    const built = await page(
      { ...listed(), connections: ["crm"] },
      {
        "actions/list.sql": "select 1",
        "actions/load.action.yaml": "connection: crm\noperation: list\neffect: reading\n"
      }
    );
    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));
    const { dataStores, connections, ...rest } = built.manifest;

    expect(builtPageManifestSchema.safeParse(built.manifest).success).toBe(true);
    const messagesOf = (manifest: unknown) =>
      builtPageManifestSchema.safeParse(manifest).error?.issues.map(({ message }) => message);
    expect(messagesOf({ ...rest, connections })).toEqual([
      "the action 'list' reaches the Data Store 'findings', which 'dataStores' does not list"
    ]);
    expect(messagesOf({ ...rest, connections, dataStores: [{ name: "other" }] })).toEqual([
      "the action 'list' reaches the Data Store 'findings', which 'dataStores' does not list"
    ]);
    expect(messagesOf({ ...rest, dataStores })).toEqual([
      "the action 'load' reaches the Connection 'crm', which 'connections' does not list"
    ]);
  });

  it("keeps a tightening policy of the manifest with the action", async () => {
    const built = await page(
      {
        ...store,
        actions: [{ name: "list", file: "actions/list.sql", effect: "reading", policy: "deny" }]
      },
      { "actions/list.sql": "select 1" }
    );
    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));

    expect(compiledActionsOf(built.manifest)).toMatchObject([{ name: "list", policy: "deny" }]);
  });
});
