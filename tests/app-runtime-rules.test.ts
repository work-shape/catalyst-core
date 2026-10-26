import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RULES, renderRuntimeRules } from "@work-shape/catalyst-app-build";
import { buildPage, scriptRuntimeErrors } from "@work-shape/catalyst-app-build/build";
import { platformDocsSkill } from "@work-shape/catalyst-client-assembly";
import { htmlManifest, pageFiles } from "./support/page-build";

const errors = (text: string, file = "script.tsx", externalHosts = false) =>
  scriptRuntimeErrors({ file, text, externalHosts });

describe("App runtime rules", () => {
  it.each(
    RULES.flatMap((rule) =>
      rule.match
        .filter((name) => !name.includes(".") && !name.includes("["))
        .flatMap((name) =>
          ["window", "globalThis", "self"].map((root) => [rule.id, `${root}.${name}`])
        )
    )
  )("refuses each browser member: %s %s", (rule, text) => {
    expect(errors(`${text};`)).toMatchObject([{ rule }]);
  });
  it.each([
    ["browser_dialog", "alert('hello'); confirm('continue?'); prompt('name'); print();"],
    ["browser_dialog", "window.confirm('continue?'); globalThis.alert('hi'); self.print();"],
    ["browser_dialog", "globalThis.confirm();"],
    ["browser_dialog", "const object = { [confirm('x')]: true };"],
    ["browser_dialog", "const { [confirm('x')]: value } = object;"],
    ["browser_dialog", "self.confirm();"],
    ["browser_dialog", "(window as any).confirm();"],
    ["browser_dialog", "(window).confirm();"],
    ["browser_dialog", "const ask = window['confirm'];"],
    ["new_window", "window.open('/'); globalThis.open('/'); self.open('/');"],
    ["new_window", 'const link = <a target="_blank" />;'],
    ["new_window", 'const link = <a target={"_blank"} />;'],
    [
      "top_navigation",
      "top.location = '/'; parent.location.href = '/'; window.parent; window.top; postMessage('x');"
    ],
    ["top_navigation", "globalThis.postMessage('x'); self.parent;"],
    ["browser_storage", "localStorage.getItem('x'); sessionStorage; indexedDB; document.cookie;"],
    [
      "browser_storage",
      "window.localStorage; globalThis.sessionStorage; self.indexedDB; window.document.cookie;"
    ],
    [
      "direct_network",
      "fetch('/'); new XMLHttpRequest(); new WebSocket('wss://example.com'); new EventSource('/');"
    ],
    ["direct_network", "const handlers = { fetch };"],
    ["direct_network", "window.fetch('/'); globalThis.WebSocket; self.EventSource;"]
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
    "function confirm() {} confirm();",
    "confirm(); function confirm() {}",
    "function ask(confirm: () => boolean) { return confirm(); }",
    "{ const alert = () => {}; alert(); }",
    "try {} catch (prompt) { console.log(prompt); }",
    "const { confirm } = dialog; confirm();",
    "const { confirm: ask, fetch: load } = dialog; ask(); load();",
    "const { nested: { confirm } } = dialog; confirm();",
    "import { confirm, storage, client } from '@work-shape/catalyst-app-kit'; confirm(); storage.get('x'); client.get();",
    "function use(window: any, globalThis: any, self: any) { window.confirm(); globalThis.fetch(); self.localStorage; }",
    "const obj = { confirm: true, fetch: true }; const value = obj.confirm;",
    "const component = <ConfirmDialog title='confirm' />; const link = <Link target='_blank' />;",
    "type confirm = () => void; type value = { fetch: string };",
    "const value = 'confirm() fetch()'; // alert()\n const element = <p>confirm</p>;",
    "const object = { get confirm() { return true; }, set fetch(value) {} };"
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

  it.each(["", ' type="module"'])(
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

  it("renders every rule and repair in the skill and sandbox docs", async () => {
    const docs = await readFile(
      new URL("../packages/docs/src/content/docs/apps/sandbox.md", import.meta.url),
      "utf8"
    );
    expect(docs).toContain(renderRuntimeRules());
    expect(platformDocsSkill.content).toContain(renderRuntimeRules());
    const reference = platformDocsSkill.resources?.find(
      ({ path }) => path === "references/apps/sandbox.md"
    );
    for (const { sentence, fix } of RULES) {
      expect(reference?.content).toContain(`${sentence} ${fix}`);
    }
  });
});
