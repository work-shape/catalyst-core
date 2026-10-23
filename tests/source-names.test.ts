import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productSourceScan, scanProductSource } from "./support/source-scan";

describe("names and paths in product source", () => {
  const scanned = productSourceScan;

  it("scans scripts, docs, the deployment kit and its own test while allowing the demo client", async () => {
    const root = await mkdtemp(join(tmpdir(), "source-names-"));
    const customerNames = ["DA" + "TEV", "da" + "tev", "Da" + "tev"];
    const demoTool = '"' + "demo" + '.example"';
    const home = ["", "Users", "example", "file"].join("/");
    const windowsHome = ["C:", "Users", "example", "file"].join("\\");
    const files = {
      "packages/example/scripts/fixture.mjs": `${customerNames[0]?.toUpperCase()} ${demoTool} ${home} ${windowsHome} ${windowsHome.replaceAll("\\", "\\\\")}`,
      "packages/docs/src/content/guide.md": `${customerNames[1] ?? ""} \`${"demo"}.yaml\``,
      "packages/deployment-kit/bin/deploy": `${customerNames[2] ?? ""} ${home}`,
      "packages/deployment-kit/host/unit.service": demoTool,
      "packages/example/src/routes.ts": '"/api/users/example"',
      "clients/demo/src/main.ts": demoTool,
      "tests/source-names.test.ts": customerNames[1] ?? ""
    };
    try {
      for (const [path, text] of Object.entries(files)) {
        await mkdir(resolve(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const result = await scanProductSource(root);
      expect(result.customerNames).toHaveLength(4);
      expect(result.demoToolNames).toEqual([
        `packages/deployment-kit/host/unit.service ${demoTool.slice(0, -1)}`,
        `packages/example/scripts/fixture.mjs ${demoTool.slice(0, -1)}`
      ]);
      expect(result.personalPaths).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("contains no operated customer names, including in documentation", async () => {
    expect((await scanned).customerNames).toEqual([]);
  });

  it("keeps demo tool names and permissions in the demo client", async () => {
    expect((await scanned).demoToolNames).toEqual([]);
  });

  it("contains no personal home paths in package sources or scripts", async () => {
    expect((await scanned).personalPaths).toEqual([]);
  });
});
