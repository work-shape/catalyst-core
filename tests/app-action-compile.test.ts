import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appActionInputAsZod,
  applyAppActionMapping,
  compiledActionsOf,
  type PageBuildResult
} from "@vivd-catalyst/app-build";
import { APP_MAX_ACTIONS, buildPage } from "@vivd-catalyst/app-build/build";
import { pageFiles } from "./support/page-build";

// The named actions of a Page as the build compiles them: one file per action, written into
// the manifest as data, and every fault an author has to fix refused with its file. Every test
// here fails without the change: before it the build read no action file, wrote the author's
// `actions` into the manifest as they stood, and refused none of these.

const page = (
  manifest: Record<string, unknown>,
  files: Record<string, string>
): Promise<PageBuildResult> =>
  buildPage({
    files: pageFiles({
      "app.yaml": JSON.stringify({ id: "orders", name: "Orders", kit: "1.1.0", ...manifest }),
      "index.html": "<!doctype html><title>Orders</title><p>Orders</p>",
      ...files
    })
  });

const loadRows = `connection: crm
operation: list_orders
effect: reading
description: The newest orders of one customer.
input:
  schema:
    type: object
    properties:
      customer: { type: string, maxLength: 20 }
      limit: { type: integer, minimum: 1, maximum: 50 }
    required: [customer]
  mapping:
    filter:
      customerNumber: "{{customer}}"
      state: open
    page: { size: "{{ limit }}" }
`;

const errorsOf = async (result: Promise<PageBuildResult>) => {
  const built = await result;
  if (built.status !== "errors") throw new Error("The Page built");
  return built.errors.map(({ file, code, message }) => ({ file, code, message }));
};

describe("the action files of a Page", () => {
  it("are compiled into the manifest, and no action file is a file of the built Page", async () => {
    const built = await page(
      { connections: ["crm"], entry: "index.html" },
      { "actions/load-rows.action.yaml": loadRows }
    );
    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));

    expect(built.manifest.actions).toEqual([
      {
        name: "load-rows",
        kind: "connection",
        file: "actions/load-rows.action.yaml",
        effect: "reading",
        description: "The newest orders of one customer.",
        connection: "crm",
        operation: "list_orders",
        input: {
          schema: {
            type: "object",
            properties: {
              customer: { type: "string", maxLength: 20 },
              limit: { type: "integer", minimum: 1, maximum: 50 }
            },
            required: ["customer"]
          },
          mapping: {
            filter: { customerNumber: "{{customer}}", state: "open" },
            page: { size: "{{ limit }}" }
          }
        }
      }
    ]);
    expect(built.files.map((file) => file.path)).toEqual(["index.html"]);
    // What a call reads is the stored manifest, whatever shape it was stored in.
    expect(compiledActionsOf(built.manifest).map((action) => action.name)).toEqual(["load-rows"]);
    expect(compiledActionsOf({ actions: [{ name: "old", effect: "reading" }] })).toEqual([]);
  });

  it("refuses an action whose Connection the manifest does not list", async () => {
    expect(
      await errorsOf(page({ entry: "index.html" }, { "actions/load-rows.action.yaml": loadRows }))
    ).toEqual([
      {
        file: "actions/load-rows.action.yaml",
        code: "connection_not_declared",
        message: expect.stringContaining("the Connection 'crm', which the manifest does not list")
      }
    ]);
  });

  it("refuses a placeholder without a parameter, an expression, and a required name without a property", async () => {
    const action = (input: string) =>
      errorsOf(
        page(
          { connections: ["crm"], entry: "index.html" },
          {
            "actions/load.action.yaml": `connection: crm\noperation: list\neffect: reading\ninput:\n${input}`
          }
        )
      );

    expect(await action('  mapping:\n    id: "{{customer}}"\n')).toEqual([
      {
        file: "actions/load.action.yaml",
        code: "action_invalid",
        message: expect.stringContaining("has no parameter 'customer'")
      }
    ]);
    for (const expression of ["{{a}}-{{b}}", "id-{{a}}", "{{ a | upper }}", "{{a.b}}", "}}"]) {
      expect(
        await action(
          `  schema:\n    type: object\n    properties:\n      a: { type: string }\n      b: { type: string }\n  mapping:\n    id: "${expression}"\n`
        ),
        expression
      ).toEqual([
        {
          file: "actions/load.action.yaml",
          code: "action_invalid",
          message: expect.stringContaining("It computes nothing")
        }
      ]);
    }
    expect(
      await action("  schema:\n    type: object\n    properties: {}\n    required: [customer]\n")
    ).toEqual([
      {
        file: "actions/load.action.yaml",
        code: "action_invalid",
        message: expect.stringContaining(
          "'customer', which 'input.schema.properties' does not hold"
        )
      }
    ]);
  });

  it("refuses a cache, a key it does not know and a declaration that says something else", async () => {
    const files = { "actions/load-rows.action.yaml": loadRows };
    const declared = (entry: Record<string, unknown>) =>
      errorsOf(
        page(
          {
            connections: ["crm"],
            entry: "index.html",
            actions: [{ name: "load-rows", effect: "reading", ...entry }]
          },
          files
        )
      );

    expect(await declared({ cache: { ttl: 60 } })).toEqual([
      {
        file: "app.yaml",
        code: "cache_not_available",
        message: expect.stringContaining("Results of actions are not cached yet")
      }
    ]);
    expect(await declared({ effect: "changing" })).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        message: expect.stringContaining("Say it once, in the file")
      }
    ]);
    expect(await declared({ file: "actions/list.function.ts" })).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        message: expect.stringContaining("no other kind of action exists yet")
      }
    ]);
    expect(
      await errorsOf(
        page(
          { connections: ["crm"], entry: "index.html" },
          {
            "actions/load.action.yaml":
              "connection: crm\noperation: list\neffect: reading\nsql: select 1\n"
          }
        )
      )
    ).toEqual([
      {
        file: "actions/load.action.yaml",
        code: "action_invalid",
        message: expect.stringContaining("Unknown key 'sql'")
      }
    ]);
  });

  // Fails without the change: a YAML file of `actions/` with another ending was passed over, so
  // the action was missing at the first call, and a missing key read "expected string, received
  // undefined".
  it("tell the author the fix for a misnamed file, a missing key and a line that is no action's", async () => {
    expect(
      await errorsOf(
        page(
          { connections: ["crm"], entry: "index.html" },
          { "actions/load.yaml": "connection: crm\noperation: list\neffect: reading\n" }
        )
      )
    ).toEqual([
      {
        file: "actions/load.yaml",
        code: "action_invalid",
        message: expect.stringContaining("is the file 'actions/load.action.yaml'")
      }
    ]);
    expect(
      await errorsOf(
        page(
          { connections: ["crm"], entry: "index.html" },
          { "actions/load.action.yaml": "connection: crm\neffect: reading\n" }
        )
      )
    ).toEqual([
      {
        file: "actions/load.action.yaml",
        code: "action_invalid",
        message: expect.stringMatching(
          /^'operation' is missing: the name of an operation the Connection offers/u
        )
      }
    ]);
    expect(
      await errorsOf(
        page(
          {
            connections: ["crm"],
            entry: "index.html",
            actions: [{ name: "load", kind: "connection", effect: "reading" }]
          },
          { "actions/load.action.yaml": "connection: crm\noperation: list\neffect: reading\n" }
        )
      )
    ).toEqual([
      {
        file: "app.yaml",
        code: "manifest_invalid",
        message: expect.stringContaining("needs no line")
      }
    ]);
  });

  it("names the limit a Page with too many actions runs into", async () => {
    const files = Object.fromEntries(
      Array.from({ length: APP_MAX_ACTIONS + 1 }, (_, index) => [
        `actions/a${index}.action.yaml`,
        "connection: crm\noperation: list\neffect: reading\n"
      ])
    );

    expect(await errorsOf(page({ connections: ["crm"], entry: "index.html" }, files))).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        message: expect.stringContaining("(APP_MAX_ACTIONS)")
      }
    ]);
  });
});

describe("the parameters of a call", () => {
  const schema = {
    type: "object" as const,
    properties: {
      customer: { type: "string" as const, maxLength: 20 },
      limit: { type: "integer" as const, minimum: 1, maximum: 50 },
      tags: { type: "array" as const, items: { type: "string" as const }, maxItems: 2 }
    },
    required: ["customer"]
  };

  it("are checked against the action's schema, and a name it does not hold is refused", () => {
    const check = appActionInputAsZod(schema);

    expect(check.safeParse({ customer: "C000001", limit: 5 }).success).toBe(true);
    expect(check.safeParse({ limit: 5 }).success).toBe(false);
    expect(check.safeParse({ customer: "C000001", limit: 51 }).success).toBe(false);
    expect(check.safeParse({ customer: "C000001", tags: ["a", "b", "c"] }).success).toBe(false);
    expect(check.safeParse({ customer: "C000001", admin: true }).success).toBe(false);
    expect(check.safeParse({ customer: { $ne: "" } }).success).toBe(false);
  });

  it("are put where their placeholders stood, as the values they are, and nothing is evaluated", () => {
    const mapping = {
      filter: { customerNumber: "{{customer}}", state: "open" },
      page: { size: "{{ limit }}" },
      tags: ["fixed", "{{tags}}"]
    };

    expect(
      applyAppActionMapping(mapping, { customer: "{{limit}}", limit: 5, tags: ["x"] })
    ).toEqual({
      // A value that looks like a placeholder is a value: it is not read a second time.
      filter: { customerNumber: "{{limit}}", state: "open" },
      page: { size: 5 },
      tags: ["fixed", ["x"]]
    });
    // A parameter the caller left out leaves out the key it stood in.
    expect(applyAppActionMapping(mapping, { customer: "C000001" })).toEqual({
      filter: { customerNumber: "C000001", state: "open" },
      page: {},
      tags: ["fixed"]
    });
    // A key of the prototype is a key like any other.
    expect(
      Object.keys(
        applyAppActionMapping(JSON.parse('{"__proto__": "{{customer}}"}'), { customer: "x" })
      )
    ).toEqual(["__proto__"]);
  });
});

// APP-6a. Fails without it: an action file named a Connection or was refused, so no App
// could start a Workflow.
describe("an action file that starts a Workflow", () => {
  const startVisit = `workflow: visit-log-entries
description: Records one visit.
input:
  schema: { type: object, properties: { page: { type: string } }, required: [page] }
  mapping: { page: "{{page}}", source: app }
`;
  const withKit = (kit: string, files: Record<string, string>, manifest = {}) =>
    buildPage({
      files: pageFiles({
        "app.yaml": JSON.stringify({
          id: "visits",
          name: "Visits",
          kit,
          entry: "index.html",
          ...manifest
        }),
        "index.html": "<!doctype html><title>Visits</title><p>Visits</p>",
        ...files
      })
    });

  it("is compiled as a changing action of the Workflow it names, with no Connection listed", async () => {
    const built = await withKit("1.3.0", { "actions/log-visit.action.yaml": startVisit });
    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));

    expect(compiledActionsOf(built.manifest)).toEqual([
      {
        name: "log-visit",
        kind: "workflow",
        file: "actions/log-visit.action.yaml",
        effect: "changing",
        description: "Records one visit.",
        workflow: "visit-log-entries",
        input: {
          schema: {
            type: "object",
            properties: { page: { type: "string" } },
            required: ["page"]
          },
          mapping: { page: "{{page}}", source: "app" }
        }
      }
    ]);
    expect(applyAppActionMapping({ page: "{{page}}", source: "app" }, { page: "/a" })).toEqual({
      page: "/a",
      source: "app"
    });
  });

  it("is refused in a Page of a kit that cannot follow the run, and with keys of a Connection action", async () => {
    expect(
      await errorsOf(withKit("1.2.0", { "actions/log-visit.action.yaml": startVisit }))
    ).toEqual([
      {
        file: "actions/log-visit.action.yaml",
        code: "action_invalid",
        message:
          "The action starts the Workflow 'visit-log-entries', and the manifest names kit 1.2.0. An App that starts a Workflow names kit 1.3.0 or later in app.yaml."
      }
    ]);
    expect(
      await errorsOf(
        withKit("1.3.0", {
          "actions/log-visit.action.yaml":
            "workflow: visit-log-entries\neffect: reading\noperation: x\n"
        })
      )
    ).toEqual([
      {
        file: "actions/log-visit.action.yaml",
        code: "action_invalid",
        message:
          "Unknown keys 'effect', 'operation'. An action file that starts a Workflow holds workflow, description, policy and input with schema and mapping."
      }
    ]);
    // A mapping that names no parameter is refused as in every action file.
    expect(
      await errorsOf(
        withKit("1.3.0", {
          "actions/log-visit.action.yaml":
            'workflow: visit-log-entries\ninput:\n  mapping: { page: "{{path}}" }\n'
        })
      )
    ).toEqual([
      {
        file: "actions/log-visit.action.yaml",
        code: "action_invalid",
        message: expect.stringContaining("has no parameter 'path'")
      }
    ]);
  });

  it("is refused where the manifest calls it reading or names a Connection for it", async () => {
    const declared = (line: Record<string, unknown>) =>
      errorsOf(
        withKit(
          "1.3.0",
          { "actions/log-visit.action.yaml": startVisit },
          { connections: ["crm"], actions: [{ name: "log-visit", ...line }] }
        )
      );

    expect(await declared({ effect: "reading" })).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        message:
          "The manifest calls the action 'log-visit' reading. It starts a Workflow, which always changes something: say 'effect: changing' or leave the line out."
      }
    ]);
    expect(await declared({ effect: "changing", connection: "crm" })).toEqual([
      {
        file: "app.yaml",
        code: "action_invalid",
        message:
          "The manifest names the Connection 'crm' for the action 'log-visit', which starts the Workflow 'visit-log-entries' and calls no Connection. Remove 'connection'."
      }
    ]);
  });
});

describe("the demo's App with a tile that reads rows", () => {
  // Fails without the change: the build knew no kit 1.1.0, no `actions` of the kit and no
  // action file. The seed writes this source on a demo instance only, so it is built here.
  it("builds with the real build, with its action compiled against the listed Connection", async () => {
    const directory = resolve("clients/demo/seed/apps/customer-list/1");
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files: Record<string, string> = {};
    for (const entry of entries.filter((candidate) => candidate.isFile())) {
      const file = join(entry.parentPath, entry.name);
      files[relative(directory, file).split(sep).join("/")] = await readFile(file, "utf8");
    }

    const built = await buildPage({ files: pageFiles(files) });

    if (built.status !== "built") throw new Error(JSON.stringify(built.errors));
    expect(built.kitVersion).toBe("1.1.0");
    expect(built.manifest.connections).toEqual(["sample-business"]);
    expect(compiledActionsOf(built.manifest)).toEqual([
      expect.objectContaining({
        name: "list-customers",
        connection: "sample-business",
        operation: "list_customers",
        effect: "reading"
      })
    ]);
  });
});
