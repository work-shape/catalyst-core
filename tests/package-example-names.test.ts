import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packages = fileURLToPath(new URL("../packages/", import.meta.url));
const denied = /exampledata|(?<![a-z])datev|exampletax|musterbau|(?<![a-z])extrade(?![a-z])/iu;

// These pinned third-party chart bundles contain updateView and repeatCount, not names.
const vendoredCharts = new Set(
  ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"].map(
    (version) => `server/vendor/app-kit/${version}/charts.js`
  )
);

async function mentions(directory = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(`${packages}${directory}`, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) {
      if (!["dist", "node_modules", ".astro"].includes(entry.name)) {
        found.push(...(await mentions(`${path}/`)));
      }
    } else if (
      entry.isFile() &&
      !vendoredCharts.has(path) &&
      /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml|sh|html|css|svg|txt)$/u.test(path)
    ) {
      const lines = (await readFile(`${packages}${path}`, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (denied.test(line)) found.push(`packages/${path}:${index + 1}`);
      }
      if (denied.test(path)) found.push(`packages/${path}`);
    }
  }
  return found.sort();
}

it("keeps customer and accounting vendor names out of reusable packages and docs", async () => {
  expect(await mentions()).toEqual([]);
});
