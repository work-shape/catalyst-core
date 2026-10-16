import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appBridgePageMessageSchema,
  appBridgeHostMessageSchema
} from "@work-shape/catalyst-api-contract";
import type { PageBuildResult } from "@work-shape/catalyst-app-build";
import { buildPage } from "@work-shape/catalyst-app-build/build";
import { pageFiles } from "./support/page-build";

// Verifier's repros for PR 69 (APP-13, APP-14, APP-15), against the owning spec
// docs/planning/specs/apps-and-pages.md ("Reserved keys", "Host bridge, version 1", checks
// 46 to 48). A test that fails names a finding of the verify report.

const page = (
  manifest: Record<string, unknown>,
  files: Record<string, string> = {}
): Promise<PageBuildResult> =>
  buildPage({
    files: pageFiles({
      "app.yaml": JSON.stringify({
        id: "orders",
        name: "Orders",
        kit: "1.3.0",
        entry: "index.html",
        ...manifest
      }),
      "index.html": "<!doctype html><title>Orders</title><p>Orders</p>",
      ...files
    })
  });

const errorsOf = async (result: Promise<PageBuildResult>) => {
  const built = await result;
  if (built.status !== "errors") throw new Error("The Page built");
  return built.errors.map(({ file, code, message }) => ({ file, code, message }));
};

const doc = readFileSync(
  new URL("../packages/docs/src/content/docs/reference/app-bridge.md", import.meta.url),
  "utf8"
);

describe("APP-14: 'requires' is reserved on an action, as the spec has it", () => {
  // Spec: "The manifest keys `rights` (top level) and `requires` (on an action) ... are
  // reserved by name." Check 47: "an action with `requires` ... is refused on save with the key
  // and the slice that builds it named".
  it("refuses 'requires' on a line under 'actions' with key_reserved", async () => {
    expect(
      await errorsOf(
        page({
          connections: ["crm"],
          actions: [{ name: "load", effect: "reading", requires: ["orders.read"] }]
        })
      )
    ).toEqual([expect.objectContaining({ code: "key_reserved", file: "app.yaml" })]);
  });

  it("refuses 'requires' in an action file with key_reserved", async () => {
    expect(
      await errorsOf(
        page(
          { connections: ["crm"] },
          {
            "actions/load.action.yaml":
              "connection: crm\noperation: list\neffect: reading\nrequires: [orders.read]\n"
          }
        )
      )
    ).toEqual([
      expect.objectContaining({ code: "key_reserved", file: "actions/load.action.yaml" })
    ]);
  });
});

describe("APP-14: each refusal names the slice that builds the key", () => {
  // Spec: "`code`, `reads` and `writes` name APP-12". The build plan has APP-12 on root main.
  it("names APP-12 for a code action", async () => {
    const [error] = await errorsOf(
      page({}, { "actions/check.action.yaml": "kind: code\nreads: [load]\nwrites: save\n" })
    );
    expect(error?.code).toBe("key_reserved");
    expect(error?.message).toContain("APP-12");
  });
});

describe("APP-15: the bridge page states what the spec asks of it", () => {
  // Spec: "A new call needs a named App that cannot be built without it, and is added as a
  // member, never by renaming one." Check 48: the documentation "states the rule for adding
  // one".
  it("states that a new call needs a named App", () => {
    expect(doc).toMatch(/named App/u);
  });

  it("does not say kit 1.0.0 had connections.call: that kit has no Connection call at all", () => {
    const kit100 = readFileSync(
      new URL("../packages/server/vendor/app-kit/1.0.0/kit.js", import.meta.url),
      "utf8"
    );
    expect(kit100).not.toContain("connection_call");
    expect(doc).not.toMatch(/Kits 1\.0\.0 to 1\.3\.0 have `connections\.call/u);
  });

  it("lists exactly the message types of the bridge schemas", () => {
    const typesOf = (schema: { options: readonly { shape: { type: { value: string } } }[] }) =>
      schema.options.map((option) => option.shape.type.value).sort();
    const tableTypes = (heading: string) => {
      const section = doc.split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "";
      return [...section.matchAll(/^\| `([a-z_]+)` \|/gmu)]
        .map((match) => match[1])
        .filter((type) => type !== "type")
        .sort();
    };
    expect(tableTypes("Messages the App sends")).toEqual(
      typesOf(appBridgePageMessageSchema).filter((type) => type !== "connection_call")
    );
    expect(tableTypes("Messages the interface sends")).toEqual(typesOf(appBridgeHostMessageSchema));
  });

  it("names every vendored kit that sends connection_call and no other", () => {
    const vendor = new URL("../packages/server/vendor/app-kit/", import.meta.url);
    const sending = readdirSync(vendor)
      .filter((version) =>
        readFileSync(new URL(`${version}/kit.js`, vendor), "utf8").includes("connection_call")
      )
      .sort();
    expect(sending).toEqual(["1.1.0", "1.2.0", "1.3.0"]);
  });
});
