import { describe, expect, it } from "vitest";
import { RULES } from "@work-shape/catalyst-app-build";
import { buildPage, scriptRuntimeErrors } from "@work-shape/catalyst-app-build/build";
import { htmlManifest, pageFiles } from "./support/page-build";

const errors = (text: string, file = "script.tsx", externalHosts = false) =>
  scriptRuntimeErrors({ file, text, externalHosts });

describe("App runtime rules", () => {
  it.each(
    RULES.flatMap((rule) =>
      rule.match
        .filter((name) => !name.includes(".") && !name.includes("["))
        .flatMap((name) => [[rule.id, `window.${name}`]])
    )
  )("refuses each browser member: %s %s", (rule, text) => {
    expect(errors(`${text};`)).toMatchObject([{ rule }]);
  });
  it.each([
    ["browser_dialog", "alert('hello'); confirm('continue?'); prompt('name'); print();"],
    ["browser_dialog", "const { [confirm('x')]: value } = object;"],
    ["browser_dialog", "(window as any).confirm();"],
    ["browser_dialog", "const ask = window['confirm'];"],
    ["new_window", 'const link = <a target={"_blank"} />;'],
    [
      "top_navigation",
      "top.location = '/'; parent.location.href = '/'; window.parent; window.top; postMessage('x');"
    ],
    ["browser_storage", "localStorage.getItem('x'); sessionStorage; indexedDB; document.cookie;"],
    [
      "direct_network",
      "fetch('/'); new XMLHttpRequest(); new WebSocket('wss://example.com'); new EventSource('/');"
    ],
    ["direct_network", "const handlers = { fetch };"]
  ])("refuses %s in %s", (rule, text) => {
    const result = errors(`\n${text}`);
    expect(result.length).toBeGreaterThan(0);
    for (const error of result) {
      const definition = RULES.find(({ id }) => id === rule);
      if (!definition) throw new Error(`Unknown rule ${rule}`);
      expect(error).toMatchObject({
        file: "script.tsx",
        line: 2,
        code: "runtime_rule",
        rule,
        sentence: definition.sentence,
        fix: definition.fix
      });
      expect(error.message).toContain(definition.fix);
    }
  });

  it.each([
    "const dialog = { confirm() {}, fetch() {} }; dialog.confirm(); dialog.fetch();",
    "confirm(); function confirm() {}",
    "try {} catch (prompt) { console.log(prompt); }",
    "const { nested: { confirm } } = dialog; confirm();",
    "import { confirm, storage, client } from '@work-shape/catalyst-app-kit'; confirm(); storage.get('x'); client.get();",
    "function use(window: any, globalThis: any, self: any) { window.confirm(); globalThis.fetch(); self.localStorage; }",
    "const component = <ConfirmDialog title='confirm' />; const link = <Link target='_blank' />;",
    "const value = 'confirm() fetch()'; // alert()\n const element = <p>confirm</p>;"
  ])("allows local names and ordinary methods: %s", (text) => {
    expect(errors(text)).toEqual([]);
  });

  it("parses TypeScript generic functions without treating them as JSX", () => {
    expect(
      errors("const ask = <T>(value: T) => { confirm('continue?'); return value; };", "script.ts")
    ).toMatchObject([{ rule: "browser_dialog" }]);
  });

  it("keeps block and parameter shadowing scoped", () => {
    expect(errors("{ let confirm = () => true; confirm(); }\nconfirm();")).toMatchObject([
      { rule: "browser_dialog", line: 2 }
    ]);
    expect(errors("function test(fetch: any) { fetch(); }\nfetch('/');")).toMatchObject([
      { rule: "direct_network", line: 2 }
    ]);
  });

  it("permits direct network only with a declared host", async () => {
    expect(errors("fetch('/'); new WebSocket('wss://example.com');", "script.js", true)).toEqual(
      []
    );
    const source = {
      "app.yaml": `${htmlManifest}externalHosts:\n  - example.com\n`,
      "index.html": "<script>fetch('https://example.com')</script>"
    };
    expect(await buildPage({ files: pageFiles(source) })).toMatchObject({ status: "built" });
  });

  it("checks unused source files and skips server actions", async () => {
    expect(
      await buildPage({
        files: pageFiles({
          "app.yaml": htmlManifest,
          "index.html": "<p>Hello</p>",
          "unused.js": "\nconfirm('x');",
          "actions/legacy.js": "fetch('/');"
        })
      })
    ).toMatchObject({
      status: "errors",
      errors: [{ file: "unused.js", line: 2, rule: "browser_dialog" }]
    });
  });

  it.each([' type="module"'])(
    "reports inline script positions in the original HTML%s",
    async (type) => {
      expect(
        await buildPage({
          files: pageFiles({
            "app.yaml": htmlManifest,
            "index.html": `<h1>Hello</h1>\n<script${type}>\nconfirm('x');\n</script>`
          })
        })
      ).toMatchObject({
        status: "errors",
        errors: [
          {
            file: "index.html",
            line: 3,
            rule: "browser_dialog",
            fix: expect.stringContaining("ConfirmDialog")
          }
        ]
      });
    }
  );

  it("checks HTML anchors including template contents, but leaves data blocks alone", async () => {
    expect(
      await buildPage({
        files: pageFiles({
          "app.yaml": htmlManifest,
          "index.html": '<h1>Hello</h1>\n<template><a target="_blank">Open</a></template>'
        })
      })
    ).toMatchObject({
      status: "errors",
      errors: [{ file: "index.html", line: 2, rule: "new_window" }]
    });
    expect(
      await buildPage({
        files: pageFiles({
          "app.yaml": htmlManifest,
          "index.html":
            '<script type="application/json">{"confirm": "fetch()"}</script><dialog>Confirm</dialog>'
        })
      })
    ).toMatchObject({ status: "built" });
  });
});
