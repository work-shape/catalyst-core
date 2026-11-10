import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_VERSION } from "@work-shape/catalyst-api-contract";
import {
  CliVersionError,
  enableSelfUpdate,
  instanceFetch,
  npmCommand,
  refreshWrittenSkills,
  releaseVersionOf,
  renderCatalystSkill,
  type SelfUpdateHost,
  updateToServerVersion
} from "@work-shape/catalyst-cli";
import { createTemporaryDirectory } from "../support/config-cli";

const GLOBAL_ROOT = "/usr/local/lib/node_modules";
const PACKAGE_ROOT = `${GLOBAL_ROOT}/@work-shape/catalyst-cli`;
const NPM_CLI = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exited ${code}`);
  }
}

interface Fake {
  host: SelfUpdateHost;
  runs: { file: string; args: readonly string[]; againFrom?: string }[];
  errors: string[];
}

function fake(overrides: Partial<SelfUpdateHost> & { files?: Record<string, string> } = {}): Fake {
  const runs: Fake["runs"] = [];
  const errors: string[] = [];
  const files: Record<string, string> = {
    [NPM_CLI]: "",
    [`${PACKAGE_ROOT}/package.json`]: JSON.stringify({ version: "0.8.0-rc.30" }),
    ...overrides.files
  };
  const host: SelfUpdateHost = {
    argv: ["context", "--json"],
    env: {},
    interactive: true,
    platform: "darwin",
    execPath: "/usr/local/bin/node",
    packageRoot: PACKAGE_ROOT,
    exists: (path) => path in files,
    readText: (path) => files[path],
    realpath: (path) => path,
    isLink: () => false,
    run: (file, args, options) => {
      runs.push({
        file,
        args,
        ...(options.againFrom === undefined ? {} : { againFrom: options.againFrom })
      });
      if (args.includes("root")) return { status: 0, stdout: `${GLOBAL_ROOT}\n`, stderr: "" };
      if (args.includes("install")) {
        files[`${PACKAGE_ROOT}/package.json`] = JSON.stringify({
          version: String(args.at(-1)).split("@").at(-1),
          bin: { catalyst: "./dist/index.js" }
        });
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 3, stdout: "", stderr: "" };
    },
    stderr: (text) => errors.push(text),
    exit: (code) => {
      throw new Exited(code);
    },
    ...overrides
  };
  return { host, runs, errors };
}

const mismatch = () => new CliVersionError("0.8.0-rc.30", "0.8.0-rc.31+build.7");

/** An instance whose answers name these versions in turn. */
function instance(...versions: string[]) {
  return instanceFetch(async () => {
    const version = versions.shift() ?? RELEASE_VERSION;
    return new Response("{}", { headers: { "catalyst-server-version": version } });
  });
}

describe("CLI self-update", () => {
  it("installs the instance's version where this CLI is installed and runs the command again once", () => {
    const { host, runs, errors } = fake();
    expect(() => updateToServerVersion(mismatch(), host)).toThrow(new Exited(3));
    expect(runs.map(({ file, args }) => [file, ...args])).toEqual([
      ["/usr/local/bin/node", NPM_CLI, "root", "--global"],
      [
        "/usr/local/bin/node",
        NPM_CLI,
        "install",
        "--global",
        "--no-fund",
        "--no-audit",
        "--loglevel=error",
        "@work-shape/catalyst-cli@0.8.0-rc.31"
      ],
      ["/usr/local/bin/node", `${PACKAGE_ROOT}/dist/index.js`, "context", "--json"]
    ]);
    // The command run again knows it is one, so it never updates a second time.
    expect(runs[2]?.againFrom).toBe("0.8.0-rc.30");
    expect(errors).toEqual([
      "The instance runs 0.8.0-rc.31; installing @work-shape/catalyst-cli@0.8.0-rc.31 in place of 0.8.0-rc.30 and running the command again.\n"
    ]);
  });

  it.each([
    ["no terminal", { interactive: false }],
    ["CI", { env: { CI: "true" } }],
    ["the opt-out", { env: { CATALYST_NO_AUTO_UPDATE: "1" } }],
    ["the command run again", { env: { CATALYST_CLI_UPDATED_FROM: "0.8.0-rc.29" } }]
  ])("keeps today's error under %s and runs nothing", (_, overrides) => {
    const { host, runs, errors } = fake(overrides);
    const error = updateToServerVersion(mismatch(), host);
    expect(error.message).toBe(
      "Catalyst CLI 0.8.0-rc.30 does not match server 0.8.0-rc.31+build.7; run: npm install --global @work-shape/catalyst-cli@0.8.0-rc.31"
    );
    expect(runs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("an opt-out of 0 or false still updates", () => {
    const { host } = fake({ env: { CATALYST_NO_AUTO_UPDATE: "false", CI: "0" } });
    expect(() => updateToServerVersion(mismatch(), host)).toThrow(Exited);
  });

  it("reports a failed install with today's error and does not run the command again", () => {
    const { host, runs, errors } = fake({
      run: (file, args) => {
        runs.push({ file, args });
        if (args.includes("root")) return { status: 0, stdout: GLOBAL_ROOT, stderr: "" };
        return {
          status: 1,
          stdout: "",
          stderr:
            "npm error code EACCES\nnpm error path /x\nnpm error A complete log of this run can be found in: /l\n"
        };
      }
    });
    const error = updateToServerVersion(mismatch(), host);
    expect(error.message).toContain(
      "run: npm install --global @work-shape/catalyst-cli@0.8.0-rc.31"
    );
    expect(runs).toHaveLength(2);
    expect(errors[1]).toBe(
      "Could not install @work-shape/catalyst-cli@0.8.0-rc.31: npm error code EACCES\n"
    );
  });

  it("leaves a copy npm does not manage globally alone", () => {
    const { host, runs } = fake({
      packageRoot: "/Users/a/.npm/_npx/1f2e/node_modules/@work-shape/catalyst-cli"
    });
    expect(updateToServerVersion(mismatch(), host)).toBeInstanceOf(CliVersionError);
    expect(runs.map(({ args }) => args.at(-1))).toEqual(["--global"]);
  });

  it("names the project's own install command for a CLI a project installed", () => {
    const { host, runs } = fake({
      interactive: false,
      packageRoot: "/work/site/node_modules/.pnpm/x/node_modules/@work-shape/catalyst-cli",
      files: { "/work/site/package.json": "{}", "/work/site/pnpm-lock.yaml": "" }
    });
    expect(updateToServerVersion(mismatch(), host).message).toBe(
      "Catalyst CLI 0.8.0-rc.30 does not match server 0.8.0-rc.31+build.7; in /work/site run: pnpm add --save-exact @work-shape/catalyst-cli@0.8.0-rc.31"
    );
    expect(runs).toEqual([]);
  });

  it("runs Windows npm through this Node, never npm.cmd or a shell", () => {
    const { host } = fake({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      files: { "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js": "" }
    });
    expect(npmCommand(host)).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"]
    });
    expect(npmCommand(fake({ platform: "win32", execPath: "D:\\node.exe" }).host)).toBeUndefined();
  });

  it("updates on the command's first answer only, never after an answer passed", async () => {
    const first = fake();
    const offFirst = enableSelfUpdate(first.host.argv, first.host);
    try {
      await expect(instance("999.0.0")("https://instance.test/api/v1/context")).rejects.toThrow(
        new Exited(3)
      );
    } finally {
      offFirst();
    }
    expect(first.runs.map(({ args }) => args.at(-1))).toEqual([
      "--global",
      "@work-shape/catalyst-cli@999.0.0",
      "--json"
    ]);

    // A deploy in the middle of a command: the second answer names a newer release.
    const later = fake();
    const offLater = enableSelfUpdate(later.host.argv, later.host);
    try {
      const send = instance(RELEASE_VERSION, "999.0.0");
      await send("https://instance.test/api/v1/auth/access-token");
      await expect(send("https://instance.test/api/v1/assets/sync")).rejects.toThrow(
        `Catalyst CLI ${RELEASE_VERSION} does not match server 999.0.0; run: npm install --global @work-shape/catalyst-cli@999.0.0`
      );
    } finally {
      offLater();
    }
    expect(later.runs).toEqual([]);
    expect(later.errors).toEqual([]);
  });

  it("never installs an older version than the one installed", () => {
    const { host, runs, errors } = fake();
    const error = updateToServerVersion(new CliVersionError("0.8.0-rc.31", "0.8.0-rc.30"), host);
    expect(error.message).toBe(
      "Catalyst CLI 0.8.0-rc.31 does not match server 0.8.0-rc.30; run: npm install --global @work-shape/catalyst-cli@0.8.0-rc.30"
    );
    expect(runs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("names pnpm's global install for a CLI pnpm installed globally", () => {
    const { host, runs } = fake({
      packageRoot:
        "/Users/a/Library/pnpm/global/5/node_modules/.pnpm/x/node_modules/@work-shape/catalyst-cli",
      files: {
        "/Users/a/Library/pnpm/global/5/package.json": "{}",
        "/Users/a/Library/pnpm/global/5/pnpm-lock.yaml": ""
      }
    });
    expect(updateToServerVersion(mismatch(), host).message).toBe(
      "Catalyst CLI 0.8.0-rc.30 does not match server 0.8.0-rc.31+build.7; run: pnpm add --global @work-shape/catalyst-cli@0.8.0-rc.31"
    );
    expect(runs).toEqual([]);
  });

  it("never replaces a checkout npm link points at", () => {
    const { host, runs } = fake({
      packageRoot: "/work/catalyst/packages/config-cli",
      isLink: (path) => path === PACKAGE_ROOT,
      realpath: (path) => (path === PACKAGE_ROOT ? "/work/catalyst/packages/config-cli" : path)
    });
    expect(updateToServerVersion(mismatch(), host)).toBeInstanceOf(CliVersionError);
    expect(runs.map(({ args }) => args.at(-1))).toEqual(["--global"]);
  });

  it("hands npm only a release version", () => {
    expect(releaseVersionOf("0.8.0-rc.31+build.7")).toBe("0.8.0-rc.31");
    for (const version of ["latest", "^0.8.0", "0.8.0 --registry=x", "../x", "1.0", "0.8.0-01"]) {
      expect(releaseVersionOf(version)).toBeUndefined();
    }
  });

  it("refreshes a skill setup wrote and keeps one the person changed", async () => {
    const home = await createTemporaryDirectory();
    const claude = join(home, ".claude", "skills", "catalyst", "SKILL.md");
    const agents = join(home, ".agents", "skills", "catalyst", "SKILL.md");
    const body = "old skill\n";
    const { createHash } = await import("node:crypto");
    const written = `${body}\n<!-- Written by catalyst setup (@work-shape/catalyst-cli 0.8.0-rc.30, sha256 ${createHash("sha256").update(body).digest("hex")}). -->\n`;
    await mkdir(join(claude, ".."), { recursive: true });
    await mkdir(join(agents, ".."), { recursive: true });
    await writeFile(claude, written);
    await writeFile(agents, `${written}my own line\n`);
    expect(await refreshWrittenSkills({ HOME: home })).toEqual([claude]);
    expect(await readFile(claude, "utf8")).toBe(await renderCatalystSkill());
    expect(await readFile(agents, "utf8")).toBe(`${written}my own line\n`);
  });
});
