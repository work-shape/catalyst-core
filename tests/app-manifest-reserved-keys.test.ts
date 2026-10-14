import { describe, expect, it } from "vitest";
import type { PageBuildResult } from "@vivd-catalyst/app-build";
import { buildPage } from "@vivd-catalyst/app-build/build";
import { pageFiles } from "./support/page-build";

// The keys a coming part of Apps will give a meaning: `rights` and `requires` at the top of the
// manifest, and the `code` action with its `reads` and `writes`. The build refuses each with
// what brings it, so that nothing names one and half works. Every test here fails without the
// change: before it the keys were refused as unknown, without the reason.

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

describe("the reserved keys of an App", () => {
  it("refuses 'rights' and 'requires' at the top of the manifest, each with what brings it", async () => {
    expect(await errorsOf(page({ rights: ["orders.read"], requires: ["crm"] }))).toEqual([
      {
        file: "app.yaml",
        code: "key_reserved",
        message: expect.stringMatching(
          /^'rights' is reserved\. Rights inside Apps are not yet decided, so no slice brings this key yet\./u
        )
      },
      {
        file: "app.yaml",
        code: "key_reserved",
        message: expect.stringMatching(
          /^'requires' is reserved\. Rights inside Apps are not yet decided/u
        )
      }
    ]);
    // An empty value is refused all the same: the key is what is reserved.
    expect(await errorsOf(page({ requires: [] }))).toEqual([
      expect.objectContaining({ code: "key_reserved" })
    ]);
  });

  it("refuses a code action in an action file, with or without its reads and writes", async () => {
    const codeAction =
      "kind: code\nscript: check.ts\nreads: [load-rows]\nwrites: save\neffect: changing\n";
    expect(await errorsOf(page({}, { "actions/check.action.yaml": codeAction }))).toEqual([
      {
        file: "actions/check.action.yaml",
        code: "key_reserved",
        message: expect.stringMatching(
          /^kind: code, 'reads', 'writes' are reserved\. A code action, with its 'reads' and 'writes', arrives with APP-12\./u
        )
      }
    ]);
    // `reads` alone on a connection action is the code action's key, and refused as such.
    expect(
      await errorsOf(
        page(
          { connections: ["crm"] },
          {
            "actions/load.action.yaml":
              "connection: crm\noperation: list\neffect: reading\nreads: [other]\n"
          }
        )
      )
    ).toEqual([
      {
        file: "actions/load.action.yaml",
        code: "key_reserved",
        message: expect.stringMatching(/^'reads' is reserved\. A code action/u)
      }
    ]);
  });

  it("refuses a code action written under 'actions' of the manifest", async () => {
    expect(
      await errorsOf(
        page({ actions: [{ name: "check", kind: "code", effect: "reading", writes: "save" }] })
      )
    ).toEqual([
      {
        file: "app.yaml",
        code: "key_reserved",
        message: expect.stringMatching(
          /^The action 'check': kind: code, 'writes' are reserved\. A code action/u
        )
      }
    ]);
  });

  it("refuses 'requires' on an action, in its file and under 'actions', as rights inside Apps", async () => {
    const why = /'requires' is reserved\. Rights inside Apps are not yet decided/u;
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
      {
        file: "actions/load.action.yaml",
        code: "key_reserved",
        message: expect.stringMatching(why)
      }
    ]);
    expect(
      await errorsOf(page({ actions: [{ name: "load", effect: "reading", requires: [] }] }))
    ).toEqual([
      {
        file: "app.yaml",
        code: "key_reserved",
        message: expect.stringMatching(/^The action 'load': 'requires' is reserved\./u)
      }
    ]);
  });

  it("still builds a manifest and an action that name none of them", async () => {
    const built = await page(
      { connections: ["crm"] },
      { "actions/load.action.yaml": "connection: crm\noperation: list\neffect: reading\n" }
    );
    expect(built.status).toBe("built");
  });
});
