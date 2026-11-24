import { describe, expect, it } from "vitest";
import type { PageBuildResult } from "@work-shape/catalyst-app-build";
import { buildPage } from "@work-shape/catalyst-app-build/build";
import { pageFiles } from "./support/page-build";

// Verifier's repros for PR 69 (APP-13, APP-14), against the owning spec
// docs/planning/specs/apps-and-pages.md ("Reserved keys", checks 46 and 47). A test that fails names a finding of the verify report.

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
