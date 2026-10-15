import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const scope = "@work-shape/catalyst-";

function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "workspace-deps-"));
  roots.push(root);
  const tree = {
    "scripts/check-workspace-deps.mjs": readFileSync("scripts/check-workspace-deps.mjs", "utf8"),
    "packages/ui/package.json": JSON.stringify({ name: `${scope}ui` }),
    "packages/app-kit/package.json": JSON.stringify({ name: `${scope}app-kit` }),
    "clients/demo/package.json": JSON.stringify({ name: `${scope}demo` }),
    ...files
  };
  for (const [file, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  const result = spawnSync(process.execPath, [join(root, "scripts/check-workspace-deps.mjs")], {
    encoding: "utf8"
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  `import type { X } from "${scope}app-kit";`,
  `export * from "${scope}app-kit";`,
  `const kit = import("${scope}app-kit");`,
  `const kit = require("${scope}app-kit");`
])("rejects an undeclared workspace import: %s", (source) => {
  const result = check({ "packages/ui/src/index.ts": source });
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${scope}app-kit missing from dependencies`);
});

it("ignores code samples and seeded App files while checking declared workspace imports", () => {
  const result = check({
    "packages/ui/src/gallery.ts": `const example = 'import { Chart } from "${scope}app-kit";';`,
    "clients/demo/seed/apps/example/1/src/index.ts": `import "${scope}app-kit";`,
    "clients/demo/src/index.ts": `import "${scope}ui";`,
    "clients/demo/package.json": JSON.stringify({
      name: `${scope}demo`,
      dependencies: { [`${scope}ui`]: "workspace:*" }
    })
  });
  expect(result.status).toBe(0);
  expect(result.output).toContain("Workspace imports are declared in 3 packages.");
});
