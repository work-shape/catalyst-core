import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/release/rename-scope.mjs");
// Assembled so the codemod does not rewrite this test when it runs over the repository.
const OLD = ["@vivd", "catalyst"].join("-");
const roots: string[] = [];

function createTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rename-scope-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

const fixture = (): Record<string, string> => ({
  "package.json": JSON.stringify({
    name: "fixture-root",
    scripts: {
      dev: `pnpm --filter ${OLD}/demo dev`,
      build: `pnpm --filter "${OLD}/*" build && pnpm --filter ${OLD}/config-cli... build`
    }
  }),
  "packages/core/package.json": JSON.stringify({ name: `${OLD}/core`, private: true }),
  "packages/chat-ui/package.json": JSON.stringify({
    name: `${OLD}/chat-ui`,
    dependencies: { [`${OLD}/core`]: "workspace:*" }
  }),
  "packages/chat-ui/src/index.ts": [
    `import { a } from "${OLD}/core";`,
    `import type { B } from '${OLD}/core/testing';`,
    `const lazy = () => import("${OLD}/api-client");`,
    `const legacy = require("${OLD}/core");`,
    `export * from "${OLD}/config-schema";`
  ].join("\n"),
  "clients/demo/package.json": JSON.stringify({
    name: `${OLD}/demo`,
    private: true,
    dependencies: { [`${OLD}/chat-ui`]: "workspace:*" }
  }),
  "clients/demo/src/styles.css": [
    `@import "${OLD}/chat-ui/styles.css";`,
    `@source "../node_modules/${OLD}/chat-ui/src/**/*.{ts,tsx}";`
  ].join("\n"),
  "tsconfig.base.json": JSON.stringify({
    compilerOptions: {
      paths: { [`${OLD}/core`]: ["packages/core/src/index.ts"], [`${OLD}/*`]: ["packages/*/src"] }
    }
  }),
  "docker/app.Dockerfile": `RUN pnpm --filter ${OLD}/core build \\\n  && pnpm --filter ${OLD}/chat-ui build\n`,
  "docker-compose.yml": `services:\n  api:\n    build:\n      args:\n        APP_PACKAGE: "${OLD}/demo"\n`,
  ".github/workflows/ci.yml": `      - run: pnpm --filter ${OLD}/demo build\n`,
  "docs/guide.md": `Install \`${OLD}/tool-sdk\` and import from it.\n`,
  "CHANGELOG.md": `- Introduced ${OLD}/core.\n`,
  "pnpm-lock.yaml": `  '${OLD}/core':\n`,
  "node_modules/dep/index.js": `require("${OLD}/core");\n`,
  "dist/index.js": `import "${OLD}/core";\n`
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rename-scope codemod", () => {
  it("reports without writing by default and fails --check while names are left", () => {
    const root = createTree(fixture());
    const before = read(root, "packages/chat-ui/src/index.ts");

    const dryRun = run(root);
    expect(dryRun.status).toBe(0);
    expect(dryRun.output).toContain("would rewrite 22 occurrence(s) in 11 file(s)");
    expect(dryRun.output).toContain(`${OLD}/demo -> @work-shape/catalyst-demo`);
    expect(read(root, "packages/chat-ui/src/index.ts")).toBe(before);

    expect(run("--check", root).status).toBe(1);
  });

  it("rewrites every specifier form and is idempotent", () => {
    const root = createTree(fixture());

    expect(run("--write", root).status).toBe(0);

    expect(read(root, "packages/chat-ui/src/index.ts")).toBe(
      [
        `import { a } from "@work-shape/catalyst-core";`,
        `import type { B } from '@work-shape/catalyst-core/testing';`,
        `const lazy = () => import("@work-shape/catalyst-api-client");`,
        `const legacy = require("@work-shape/catalyst-core");`,
        `export * from "@work-shape/catalyst-config-schema";`
      ].join("\n")
    );
    expect(JSON.parse(read(root, "packages/chat-ui/package.json"))).toEqual({
      name: "@work-shape/catalyst-chat-ui",
      dependencies: { "@work-shape/catalyst-core": "workspace:*" }
    });
    expect(JSON.parse(read(root, "package.json")).scripts).toEqual({
      dev: "pnpm --filter @work-shape/catalyst-demo dev",
      build:
        'pnpm --filter "@work-shape/catalyst-*" build && pnpm --filter @work-shape/catalyst-config-cli... build'
    });
    expect(JSON.parse(read(root, "tsconfig.base.json")).compilerOptions.paths).toEqual({
      "@work-shape/catalyst-core": ["packages/core/src/index.ts"],
      "@work-shape/catalyst-*": ["packages/*/src"]
    });
    expect(read(root, "clients/demo/src/styles.css")).toBe(
      [
        `@import "@work-shape/catalyst-chat-ui/styles.css";`,
        `@source "../node_modules/@work-shape/catalyst-chat-ui/src/**/*.{ts,tsx}";`
      ].join("\n")
    );
    expect(read(root, "docker/app.Dockerfile")).toContain("--filter @work-shape/catalyst-chat-ui");
    expect(read(root, "docker-compose.yml")).toContain('APP_PACKAGE: "@work-shape/catalyst-demo"');
    expect(read(root, ".github/workflows/ci.yml")).toContain("@work-shape/catalyst-demo build");
    expect(read(root, "docs/guide.md")).toContain("`@work-shape/catalyst-tool-sdk`");

    for (const skipped of [
      "CHANGELOG.md",
      "pnpm-lock.yaml",
      "node_modules/dep/index.js",
      "dist/index.js"
    ]) {
      expect(read(root, skipped)).toContain(`${OLD}/core`);
    }

    expect(run("--check", root).status).toBe(0);
    const second = run("--write", root);
    expect(second.status).toBe(0);
    expect(second.output).toContain("rewrote 0 occurrence(s) in 0 file(s)");
  });

  it("gives deployment packages their explicit names across several roots", () => {
    const platform = createTree({
      "packages/core/package.json": JSON.stringify({ name: `${OLD}/core` })
    });
    const deployment = createTree({
      "package.json": JSON.stringify({
        name: `${OLD}/acme`,
        private: true,
        dependencies: { [`${OLD}/core`]: "workspace:*" }
      }),
      "docker-compose.yml": `APP_PACKAGE: "${OLD}/acme"\n`
    });

    expect(run("--write", "--assembly", "acme", platform, deployment).status).toBe(0);

    expect(JSON.parse(read(deployment, "package.json"))).toEqual({
      name: "@work-shape/deployment-acme",
      private: true,
      dependencies: { "@work-shape/catalyst-core": "workspace:*" }
    });
    expect(read(deployment, "docker-compose.yml")).toBe(
      'APP_PACKAGE: "@work-shape/deployment-acme"\n'
    );
    expect(JSON.parse(read(platform, "packages/core/package.json")).name).toBe(
      "@work-shape/catalyst-core"
    );
  });

  it("renames the server package and the local examplecorp assembly without moving files", () => {
    const platform = createTree({
      "packages/server/package.json": JSON.stringify({ name: `${OLD}/chat-server` }),
      "src/server.ts": `export * from "${OLD}/chat-server";\n`
    });
    const deployment = createTree({
      "package.json": JSON.stringify({ name: `${OLD}/examplecorp`, private: true }),
      "deploy/deployment.env": `APP_PACKAGE=${OLD}/examplecorp\n`
    });

    expect(run("--write", "--assembly", "examplecorp", platform, deployment).status).toBe(0);
    expect(JSON.parse(read(platform, "packages/server/package.json")).name).toBe(
      "@work-shape/catalyst-server"
    );
    expect(read(platform, "src/server.ts")).toContain('"@work-shape/catalyst-server"');
    expect(JSON.parse(read(deployment, "package.json")).name).toBe(
      "@work-shape/deployment-examplecorp"
    );
    expect(read(deployment, "deploy/deployment.env")).toBe(
      "APP_PACKAGE=@work-shape/deployment-examplecorp\n"
    );
    expect(run("--check", platform, deployment).status).toBe(0);
  });

  it("refuses to guess a name for an unlisted client or deployment package", () => {
    const manifest = JSON.stringify({ name: `${OLD}/examplecorp`, private: true });
    const root = createTree({
      "package.json": manifest,
      "src/index.ts": `import "${OLD}/core";\n`
    });

    const listed = createTree({
      "package.json": JSON.stringify({ name: `${OLD}/acme`, private: true })
    });
    const result = run("--write", "--assembly", "acme", listed, root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("no target in ASSEMBLY_TARGETS");
    expect(result.output).toContain("Pass --assembly <name>");
    expect(JSON.parse(read(listed, "package.json")).name).toBe(`${OLD}/acme`);
    expect(read(root, "package.json")).toBe(manifest);
    expect(read(root, "src/index.ts")).toContain(`${OLD}/core`);
  });

  it("accepts repeated --assembly options and keeps built-in deployment targets", () => {
    const root = createTree({
      "clients/acme/package.json": JSON.stringify({ name: `${OLD}/acme` }),
      "clients/examplecorp/package.json": JSON.stringify({ name: `${OLD}/examplecorp` }),
      "clients/deployment/package.json": JSON.stringify({ name: `${OLD}/catalyst-deployment` }),
      "src/index.ts": `import "${OLD}/acme/tools";\nimport "${OLD}/examplecorp";\n`
    });

    expect(run("--assembly", "acme", root, "--assembly", "examplecorp", "--write").status).toBe(0);
    expect(JSON.parse(read(root, "clients/acme/package.json")).name).toBe(
      "@work-shape/deployment-acme"
    );
    expect(JSON.parse(read(root, "clients/examplecorp/package.json")).name).toBe(
      "@work-shape/deployment-examplecorp"
    );
    expect(JSON.parse(read(root, "clients/deployment/package.json")).name).toBe(
      "@work-shape/deployment-catalyst"
    );
    expect(read(root, "src/index.ts")).toBe(
      'import "@work-shape/deployment-acme/tools";\nimport "@work-shape/deployment-examplecorp";\n'
    );
    expect(run("--check", "--assembly", "acme", "--assembly", "examplecorp", root).status).toBe(0);
  });

  it.each(["", "--write", "../acme", "@example/acme"])(
    "refuses a missing or invalid assembly name: %j",
    (name) => {
      const root = createTree(fixture());
      const before = read(root, "packages/core/package.json");

      expect(run(root, "--assembly", ...(name ? [name] : [])).status).toBe(2);
      expect(read(root, "packages/core/package.json")).toBe(before);
    }
  );

  it("reports scope uses it cannot rewrite instead of touching them", () => {
    const root = createTree({
      ".npmrc": `${OLD}:registry=https://registry.npmjs.org/\n`,
      "src/names.ts": `export const prefix = "${OLD}/";\n`
    });

    const result = run("--write", root);

    expect(result.status).toBe(1);
    expect(result.output).toContain(".npmrc:1:");
    expect(result.output).toContain("src/names.ts:1:");
    expect(read(root, ".npmrc")).toContain(`${OLD}:registry`);
  });
});
