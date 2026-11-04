import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLISHED_CLI_VERSION } from "@work-shape/catalyst-api-contract";
import {
  checkPublishedCliVersion,
  readCliPackageVersion,
  readPublishedCliVersion,
  setPublishedCliVersion
} from "../scripts/release/cli-version.mjs";
import { repoRoot } from "../scripts/release/changelog.mjs";

const scratch: string[] = [];
function fixture(constant: string, cliVersion: string) {
  const root = mkdtempSync(join(tmpdir(), "catalyst-cli-version-"));
  scratch.push(root);
  for (const [path, text] of [
    [
      "packages/api-contract/src/public-cli.ts",
      `/** Doc. */\nexport const PUBLISHED_CLI_VERSION: string | undefined = ${constant};\n`
    ],
    ["packages/config-cli/package.json", JSON.stringify({ version: cliVersion })]
  ] as const) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PUBLISHED_CLI_VERSION", () => {
  it("is the version of the CLI package released with this platform version", () => {
    expect(PUBLISHED_CLI_VERSION).toBe(readCliPackageVersion(repoRoot));
    expect(checkPublishedCliVersion(repoRoot)).toBe(PUBLISHED_CLI_VERSION);
  });

  it("fails when the constant differs from the CLI package or is unset", () => {
    expect(() => checkPublishedCliVersion(fixture('"0.7.0"', "0.8.0-rc.24"))).toThrow(
      /"0\.7\.0".*0\.8\.0-rc\.24/u
    );
    expect(() => checkPublishedCliVersion(fixture("undefined", "0.8.0"))).toThrow(/unset/u);
    expect(checkPublishedCliVersion(fixture('"0.8.0"', "0.8.0"))).toBe("0.8.0");
  });

  it("is rewritten to the cut version, from a set or an unset value", () => {
    for (const constant of ['"0.7.0"', "undefined"]) {
      const root = fixture(constant, "0.9.0-rc.1");
      setPublishedCliVersion(root, "0.9.0-rc.1");
      expect(readPublishedCliVersion(root)).toBe("0.9.0-rc.1");
      expect(checkPublishedCliVersion(root)).toBe("0.9.0-rc.1");
    }
  });
});
