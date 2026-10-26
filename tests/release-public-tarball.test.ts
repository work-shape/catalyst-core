import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/release/check-public-tarball.mjs");
// Assembled so that this test file names no workspace package as an import.
const PRIVATE_CORE = ["@work-shape", "catalyst-core"].join("/");
const LEGACY_CORE = [["@vivd", "catalyst"].join("-"), "core"].join("/");
const roots: string[] = [];

const manifest = {
  name: "@work-shape/catalyst-cli",
  version: "0.0.0",
  license: "MIT",
  type: "module",
  bin: { catalyst: "./dist/index.js" },
  publishConfig: { access: "public" },
  dependencies: { zod: "^4.4.3" }
};

/** An unpacked package that may be published, with the given files added or replaced. */
function unpacked(files: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "public-tarball-"));
  roots.push(root);
  const all: Record<string, string | null> = {
    "package.json": JSON.stringify(manifest),
    LICENSE: "MIT License\n\nCopyright (c) the authors\n",
    "dist/index.js": [
      "#!/usr/bin/env node",
      "// src/index.ts",
      'import { parseArgs } from "node:util";',
      "// ../api-contract/src/shared.ts",
      'import { z } from "zod";',
      "export const ready = [parseArgs, z].length;",
      ""
    ].join("\n"),
    ...files
  };
  for (const [file, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function check(root: string) {
  const result = spawnSync(process.execPath, [script, "--dir", root], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the public tarball check", () => {
  it("passes a package of public source with third-party dependencies and a licence", () => {
    expect(check(unpacked())).toEqual({ status: 0, output: "check-public-tarball passed\n" });
  });

  it.each([undefined, PRIVATE_CORE, LEGACY_CORE, `${manifest.name}-extra`])(
    "checks a full npm install, excluding only the CLI itself (dependency: %s)",
    (dependency) => {
      const workDir = mkdtempSync(join(tmpdir(), "public-tool-install-"));
      roots.push(workDir);
      const pack = (root: string, name: string) => {
        const tarball = join(workDir, `${name}.tgz`);
        const packageDir = join(workDir, name, "package");
        mkdirSync(dirname(packageDir), { recursive: true });
        cpSync(root, packageDir, { recursive: true });
        const result = spawnSync("tar", ["-czf", tarball, "package"], {
          cwd: dirname(packageDir),
          encoding: "utf8"
        });
        expect(result.status, result.stderr).toBe(0);
        return tarball;
      };
      const dependencies: Record<string, string> = {};
      if (dependency) {
        const root = unpacked({
          "package.json": JSON.stringify({ name: dependency, version: "1.0.0" })
        });
        dependencies[dependency] = `file:${pack(root, "dependency")}`;
      }
      const root = unpacked({
        "package.json": JSON.stringify({ ...manifest, version: "0.7.0", dependencies }),
        "dist/index.js": '#!/usr/bin/env node\nconsole.log("Usage: catalyst");\n'
      });
      const tarball = pack(root, "cli");
      const code = `import { checkInstall } from ${JSON.stringify(pathToFileURL(script).href)};
console.log(JSON.stringify(checkInstall(process.argv[1], process.argv[2], process.argv[3])));`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", code, tarball, workDir, manifest.name],
        { encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        dependency ? [`the install pulled in the workspace package ${dependency}@1.0.0`] : []
      );
    }
  );

  it.each([PRIVATE_CORE, LEGACY_CORE])("fails a bundle that imports %s", (name) => {
    const result = check(
      unpacked({
        "dist/index.js": `import { AppError } from "${name}";\nexport { AppError };\n`
      })
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain(`dist/index.js: imports the workspace package ${name}`);
  });

  it.each([PRIVATE_CORE, LEGACY_CORE])("fails a manifest that depends on %s", (name) => {
    const result = check(
      unpacked({
        "package.json": JSON.stringify({
          ...manifest,
          dependencies: { ...manifest.dependencies, [name]: "0.6.3" }
        })
      })
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain(`the manifest depends on the workspace package ${name}`);
  });

  it("allows core's standalone hash helper", () => {
    const result = check(
      unpacked({ "dist/index.js": "// ../core/src/sha256.ts\nexport const hash = 1;\n" })
    );
    expect(result.status).toBe(0);
  });

  it("fails a bundle that holds source outside the allowed entries", () => {
    const result = check(
      unpacked({ "dist/index.js": "// ../core/src/secrets.ts\nexport const resolver = 1;\n" })
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "dist/index.js: bundles ../core/src/secrets.ts, which is outside the public packages"
    );
  });

  it("fails a bundle that holds a third-party module the manifest does not install", () => {
    const result = check(
      unpacked({
        "dist/index.js":
          '// ../../node_modules/left-pad/index.js\nimport pad from "left-pad";\nexport { pad };\n'
      })
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain("which is outside the public packages");
    expect(result.output).toContain("imports left-pad, which the manifest does not declare");
  });

  it("fails without a licence file and with another licence", () => {
    expect(check(unpacked({ LICENSE: null })).output).toContain("the LICENSE file is missing");
    const unlicensed = check(
      unpacked({ "package.json": JSON.stringify({ ...manifest, license: "UNLICENSED" }) })
    );
    expect(unlicensed.status).toBe(1);
    expect(unlicensed.output).toContain("the licence is UNLICENSED, not MIT");
  });

  it("fails on what looks like a credential and on a file that holds credentials", () => {
    // Assembled so that no scanner reads this test as a leaked key.
    const key = ["cat", "cred_0123456789", "s".repeat(40)].join(".");
    const inSource = check(unpacked({ "dist/index.js": `export const key = "${key}";\n` }));
    expect(inSource.status).toBe(1);
    expect(inSource.output).toContain(
      "dist/index.js: contains what looks like this: instance API key"
    );
    expect(inSource.output).not.toContain(key);

    const block = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    expect(check(unpacked({ "dist/key.js": `export const pem = "${block}";\n` })).status).toBe(1);

    const envFile = check(unpacked({ ".env": "A=1\n" }));
    expect(envFile.status).toBe(1);
    expect(envFile.output).toContain(".env: a file of this name holds credentials");
  });

  it("fails on a file outside dist", () => {
    const result = check(unpacked({ "src/index.ts": "export {};\n" }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "src/index.ts: only dist/, skills/, LICENSE and README.md are published"
    );
  });
});
