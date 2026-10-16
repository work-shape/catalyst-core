// The kit for deployments that install released packages: the version pin, bump, the
// manifest with catalystVersion, pack-local's manifest, the package copy of the Dockerfile and
// the system layers it shares with the source Dockerfiles. `pnpm test:deployment-kit`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { copyPackages } from "../docker/copy-packages.mjs";
import { compareVersions, versionProblems, withVersion } from "../lib/catalyst-versions.mjs";
import {
  integrityProblems,
  KNOWN_INTEGRITY,
  restoreIntegrity,
  urlTarballs
} from "../lib/lock-integrity.mjs";
import { localManifest } from "../lib/pack-local.mjs";

const kitDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platformRoot = resolve(kitDir, "../..");
const catalystDeploy = join(kitDir, "bin/catalyst-deploy");
const scratch = mkdtempSync(join(tmpdir(), "deployment-kit-packages-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const pinned = (version) => ({
  name: "@example/fixture",
  dependencies: {
    "@work-shape/catalyst-client-assembly": version,
    "@work-shape/catalyst-document-worker": version,
    react: "^19.2.7"
  },
  devDependencies: {
    "@work-shape/catalyst-deployment-kit": version,
    typescript: "^6.0.3"
  }
});

describe("the version pin", () => {
  test("accepts one exact release for every catalyst package", () => {
    assert.deepEqual(versionProblems(pinned("0.8.0")), []);
    assert.deepEqual(versionProblems(pinned("0.8.0-rc.1")), []);
  });

  test("refuses local specifiers, ranges, mixed versions and overrides", () => {
    const [local] = versionProblems(pinned("workspace:*"));
    assert.match(local, /dependencies\.@work-shape\/catalyst-client-assembly is workspace:\*/u);
    assert.match(versionProblems(pinned("file:../x.tgz"))[0], /a local package never reaches/u);
    assert.match(versionProblems(pinned("^0.8.0"))[0], /not an exact release version/u);
    assert.match(versionProblems(pinned("0.8.0-beta.1"))[0], /not an exact release version/u);

    const mixed = pinned("0.8.0");
    mixed.devDependencies["@work-shape/catalyst-deployment-kit"] = "0.7.0";
    assert.deepEqual(versionProblems(mixed), [
      "the catalyst packages name 2 versions (0.8.0, 0.7.0); all must be one release"
    ]);

    const overridden = {
      ...pinned("0.8.0"),
      pnpm: { overrides: { "@work-shape/catalyst-core@0.8.0": "link:../core", zod: "4.4.3" } },
      resolutions: { "a>@work-shape/catalyst-ui": "0.7.0" }
    };
    assert.deepEqual(versionProblems(overridden), [
      "pnpm.overrides.@work-shape/catalyst-core@0.8.0 replaces a pinned catalyst package",
      "resolutions.a>@work-shape/catalyst-ui replaces a pinned catalyst package"
    ]);

    assert.deepEqual(versionProblems({ name: "x", dependencies: { react: "19" } }), [
      "package.json names no @work-shape/catalyst-* dependency"
    ]);
  });

  test("bumps every catalyst package and nothing else", () => {
    const next = withVersion(pinned("0.7.0"), "0.8.0");
    assert.deepEqual(next, {
      ...pinned("0.8.0"),
      dependencies: { ...pinned("0.8.0").dependencies, react: "^19.2.7" }
    });
  });

  test("orders release candidates before their release", () => {
    const sorted = ["0.10.0", "0.8.0", "0.8.0-rc.2", "0.9.1", "0.8.0-rc.10", "0.8.1"].sort(
      compareVersions
    );
    assert.deepEqual(sorted, ["0.8.0-rc.2", "0.8.0-rc.10", "0.8.0", "0.8.1", "0.9.1", "0.10.0"]);
  });
});

// A deployment that installs released packages, with a Git commit.
function packageDeployment(name, manifest) {
  const root = join(scratch, name, "deployment.fixture");
  mkdirSync(join(root, "deploy"), { recursive: true });
  writeFileSync(
    join(root, "deploy/deployment.env"),
    "INSTANCE=fixture\nIMAGE_REPOSITORY=ghcr.io/example/fixture\nAPP_PACKAGE=@example/fixture\nEXECUTION_WORKSPACES=1\n"
  );
  writeJson(join(root, "package.json"), manifest);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture"
  );
  return { root, head: git("rev-parse", "HEAD").trim() };
}

// Runs catalyst-deploy for the fixture deployment. `pathPrefix` puts fake commands first on
// PATH. env(1) and sh set the variables, so the test inherits its environment unread.
function deploy(root, args, pathPrefix) {
  const command = ["env", `DEPLOYMENT_ROOT=${root}`, catalystDeploy, ...args];
  return pathPrefix
    ? spawnSync("sh", ["-c", 'PATH="$0:$PATH" exec "$@"', pathPrefix, ...command], {
        encoding: "utf8"
      })
    : spawnSync(command[0], command.slice(1), { encoding: "utf8" });
}

const images = Object.fromEntries(
  [
    ["api", "api"],
    ["ui", "ui"],
    ["doc-worker", "doc-worker"],
    ["workspace-command-worker", "workspace-command-worker"],
    ["artifact-preview-worker", "artifact-preview-worker"],
    ["runner", "catalyst-runner-base"]
  ].map(([key, suffix]) => [key, `ghcr.io/example/fixture-${suffix}@sha256:${"1".repeat(64)}`])
);

describe("the release manifest of a deployment that installs released packages", () => {
  const { root, head } = packageDeployment("manifest", pinned("0.8.0-rc.1"));
  const file = join(scratch, "manifest.json");

  test("records catalystVersion and the deployment commit, schema 2", () => {
    const written = deploy(root, [
      "manifest",
      "write",
      "--release",
      "staging-2026.10.16-1",
      "--images",
      JSON.stringify(images)
    ]);
    assert.equal(written.status, 0, written.stderr);
    const manifest = JSON.parse(written.stdout);
    assert.deepEqual(manifest, {
      schema: 2,
      release: "staging-2026.10.16-1",
      catalystVersion: "0.8.0-rc.1",
      commits: { deployment: head },
      images
    });
    writeFileSync(file, written.stdout);
    assert.equal(deploy(root, ["manifest", "check", file, "--commit", head]).status, 0);
  });

  test("refuses a schema 2 manifest with refs or without a release version", () => {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const broken of [
      { ...manifest, commits: { ...manifest.commits, platform: head } },
      { ...manifest, catalystVersion: "^0.8.0" },
      { ...manifest, catalystVersion: undefined }
    ]) {
      writeJson(join(scratch, "broken.json"), broken);
      const checked = deploy(root, ["manifest", "check", join(scratch, "broken.json")]);
      assert.notEqual(checked.status, 0);
      assert.match(checked.stderr, /invalid manifest/u);
    }
  });

  test("is not written while the pin is broken", () => {
    const broken = packageDeployment("manifest-broken", pinned("workspace:*"));
    const written = deploy(broken.root, [
      "manifest",
      "write",
      "--release",
      "staging-1",
      "--images",
      JSON.stringify(images)
    ]);
    assert.notEqual(written.status, 0);
    assert.match(written.stderr, /a local package never reaches a release/u);
  });

  test("is deployed only by the kit of the same release", () => {
    const kitVersion = JSON.parse(readFileSync(join(kitDir, "package.json"), "utf8")).version;
    const otherVersion = `${Number(kitVersion.split(".")[0]) + 1}.0.0`;
    const mismatched = join(scratch, "mismatched-kit.json");
    writeJson(mismatched, {
      ...JSON.parse(readFileSync(file, "utf8")),
      catalystVersion: otherVersion
    });
    const deployed = deploy(root, [
      "deploy",
      "--host",
      "host.example.test",
      "--manifest",
      mismatched
    ]);
    assert.notEqual(deployed.status, 0);
    assert.ok(
      deployed.stderr.includes(
        `built from Catalyst ${otherVersion}; this deployment kit is ${kitVersion}`
      ),
      deployed.stderr
    );
  });
});

describe("the commands of a deployment that installs released packages", () => {
  test("the release gate needs only the deployment root and refuses linked source", () => {
    const { root } = packageDeployment("linked", pinned("0.8.0"));
    for (const name of Object.keys({
      ...pinned("0.8.0").dependencies,
      ...pinned("0.8.0").devDependencies
    }).filter((name) => name.startsWith("@work-shape/"))) {
      const source = join(scratch, "linked", "source", name);
      writeJson(join(source, "package.json"), { name, version: "0.8.0" });
      mkdirSync(dirname(join(root, "node_modules", name)), { recursive: true });
      symlinkSync(source, join(root, "node_modules", name));
    }
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const result = spawnSync(
      "bash",
      [join(kitDir, "lib/check-release.sh"), "--deployment-root", root],
      { encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /links .*, not the released package/u);
  });

  test("bump refuses a version that is not on npm and changes nothing", () => {
    const { root } = packageDeployment("bump-missing", pinned("0.7.0"));
    const before = readFileSync(join(root, "package.json"), "utf8");
    const bin = fakeTools("bump-missing", { published: ["@work-shape/catalyst-client-assembly"] });
    const result = deploy(root, ["bump", "0.8.0"], bin);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /@work-shape\/catalyst-document-worker@0\.8\.0 is not on npm/u);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
    assert.equal(existsSync(join(bin, "pnpm.log")), false);
  });

  test("bump pins the version, rewrites the lockfile alone and prints release notes", () => {
    const { root } = packageDeployment("bump", pinned("0.7.0"));
    const bin = fakeTools("bump", { published: "all" });
    const result = deploy(root, ["bump", "0.8.0"], bin);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), pinned("0.8.0"));
    assert.equal(
      readFileSync(join(bin, "pnpm.log"), "utf8"),
      "install --lockfile-only --ignore-workspace\n"
    );
    assert.match(result.stdout, /Pinned 3 catalyst packages at 0\.8\.0 \(were 0\.7\.0\)/u);
    assert.match(result.stdout, /## work-shape\/catalyst-core v0\.8\.0\n\nnotes of v0\.8\.0/u);
    assert.doesNotMatch(result.stdout, /v0\.7\.0|v0\.9\.0/u);
  });

  test("bump puts everything back when the new lockfile loses a tarball's integrity", () => {
    const { root } = packageDeployment("bump-integrity", pinned("0.7.0"));
    const tarball = "https://cdn.example.test/xlsx.tgz";
    const lock = (integrity) =>
      `packages:\n  xlsx@${tarball}:\n    resolution: {${integrity}tarball: ${tarball}}\n`;
    writeFileSync(join(root, "pnpm-lock.yaml"), lock("integrity: sha512-fixture, "));
    const before = readFileSync(join(root, "package.json"), "utf8");
    const bin = fakeTools("bump-integrity", { published: "all", writesLock: lock("") });
    const result = deploy(root, ["bump", "0.8.0"], bin);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /xlsx\.tgz has no integrity in the lockfile/u);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
    assert.equal(
      readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
      lock("integrity: sha512-fixture, ")
    );
  });
});

// npm view answers for the published names, pnpm logs its arguments (and writes `writesLock` as
// the lockfile), gh lists v0.7.0 to v0.9.0.
function fakeTools(name, { published, writesLock }) {
  const bin = join(scratch, name, "bin");
  mkdirSync(bin, { recursive: true });
  const script = (file, body) => {
    writeFileSync(join(bin, file), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, file), 0o755);
  };
  const names = published === "all" ? "" : published.join(" ");
  script(
    "npm",
    `spec="$2"; name="\${spec%@*}"
if [[ -z "${names}" || " ${names} " == *" $name "* ]]; then echo "\\"\${spec##*@}\\""; exit 0; fi
echo "npm error 404 Not Found" >&2; exit 1`
  );
  if (writesLock) writeFileSync(join(bin, "lock"), writesLock);
  script(
    "pnpm",
    `echo "$*" >> "${join(bin, "pnpm.log")}"${writesLock ? `\ncp "${join(bin, "lock")}" pnpm-lock.yaml` : ""}`
  );
  script(
    "gh",
    `if [[ "$2" == list ]]; then echo '[{"tagName":"v0.9.0"},{"tagName":"v0.8.0"},{"tagName":"v0.8.0-rc.1"},{"tagName":"v0.7.0"}]'; else echo "notes of $3"; fi`
  );
  return bin;
}

describe("the URL tarball integrity", () => {
  test("is the one core's lockfile records for SheetJS", () => {
    const core = urlTarballs(readFileSync(join(platformRoot, "pnpm-lock.yaml"), "utf8"));
    for (const [tarball, integrity] of KNOWN_INTEGRITY) {
      assert.equal(core.get(tarball), integrity, tarball);
    }
  });

  test("is put back where pnpm dropped it, and checked", () => {
    const [[tarball, integrity]] = KNOWN_INTEGRITY;
    const dropped = `packages:\n  xlsx@${tarball}:\n    resolution: {tarball: ${tarball}}\n`;
    assert.deepEqual(integrityProblems(dropped), [`${tarball} has no integrity in the lockfile`]);
    const restored = restoreIntegrity(dropped);
    assert.match(
      restored,
      new RegExp(`resolution: \\{integrity: ${integrity.replaceAll("+", "\\+")}, tarball`, "u")
    );
    assert.deepEqual(integrityProblems(restored), []);
    assert.match(
      integrityProblems(restored.replace(integrity, "sha512-changed"))[0],
      /has the integrity sha512-changed, not sha512-/u
    );
  });
});

describe("the kit's scripts", () => {
  // A deployment runs them from node_modules/@work-shape/catalyst-deployment-kit, a link.
  test("run when started through a link", () => {
    const root = join(scratch, "linked");
    writeJson(join(root, "package.json"), pinned("0.8.0"));
    const linked = join(scratch, "linked-kit");
    symlinkSync(kitDir, linked);
    const versions = spawnSync(
      process.execPath,
      [join(linked, "lib/catalyst-versions.mjs"), "version", root],
      { encoding: "utf8" }
    );
    assert.equal(versions.stdout.trim(), "0.8.0", versions.stderr);
    for (const script of ["docker/copy-packages.mjs", "lib/pack-local.mjs"]) {
      const usage = spawnSync(process.execPath, [join(linked, script)], { encoding: "utf8" });
      assert.equal(usage.status, 1, script);
      assert.match(usage.stderr, /required|usage/u, script);
    }
  });
});

describe("pack-local's throwaway manifest", () => {
  const tarballs = new Map([
    ["@work-shape/catalyst-client-assembly", "work-shape-catalyst-client-assembly-0.7.0.tgz"],
    ["@work-shape/catalyst-document-worker", "work-shape-catalyst-document-worker-0.7.0.tgz"],
    ["@work-shape/catalyst-deployment-kit", "work-shape-catalyst-deployment-kit-0.7.0.tgz"],
    ["@work-shape/catalyst-core", "work-shape-catalyst-core-0.7.0.tgz"]
  ]);

  test("takes every catalyst package from its tarball, its own and the ones beneath", () => {
    const manifest = { ...pinned("0.8.0"), pnpm: { overrides: { zod: "4.4.3" } } };
    const local = localManifest(manifest, tarballs, "pnpm@10.29.3");
    assert.equal(
      local.dependencies["@work-shape/catalyst-client-assembly"],
      "file:.local-packages/work-shape-catalyst-client-assembly-0.7.0.tgz"
    );
    assert.equal(local.dependencies.react, "^19.2.7");
    assert.equal(
      local.pnpm.overrides["@work-shape/catalyst-core"],
      "file:.local-packages/work-shape-catalyst-core-0.7.0.tgz"
    );
    assert.equal(local.pnpm.overrides.zod, "4.4.3");
    assert.equal(local.packageManager, "pnpm@10.29.3");
    assert.match(versionProblems(local)[0], /a local package never reaches a release/u);
  });

  test("refuses a package the workspace does not have", () => {
    const manifest = pinned("0.8.0");
    manifest.dependencies["@work-shape/catalyst-missing"] = "0.8.0";
    assert.throws(
      () => localManifest(manifest, tarballs),
      /no package @work-shape\/catalyst-missing/u
    );
  });
});

describe("the package copy of the runner and document worker images", () => {
  // node_modules/.pnpm as pnpm lays it out: each package beside links to its dependencies.
  function install(name) {
    const from = join(scratch, name);
    const store = join(from, "node_modules/.pnpm");
    const add = (key, pkg, manifest, dependencies = {}) => {
      writeJson(join(store, key, "node_modules", pkg, "package.json"), manifest);
      for (const [dependency, target] of Object.entries(dependencies)) {
        const link = join(store, key, "node_modules", dependency);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(target, link);
      }
    };
    add(
      "@scope+tool@1.0.0",
      "@scope/tool",
      { name: "@scope/tool", bin: { tool: "./cli.js", "tool-x": "./x.js" } },
      {
        helper: "../../helper@2.0.0/node_modules/helper"
      }
    );
    writeFileSync(join(store, "@scope+tool@1.0.0/node_modules/@scope/tool/cli.js"), "");
    writeFileSync(join(store, "@scope+tool@1.0.0/node_modules/@scope/tool/x.js"), "");
    add(
      "helper@2.0.0",
      "helper",
      { name: "helper" },
      { deep: "../../deep@3.0.0/node_modules/deep" }
    );
    add("deep@3.0.0", "deep", { name: "deep" });
    add("unrelated@1.0.0", "unrelated", { name: "unrelated" });
    return from;
  }

  test("copies a package with exactly what it depends on and lists its commands", () => {
    const from = install("copy");
    const to = join(scratch, "copy-out");
    const { packageCount, commands } = copyPackages({ from, to, names: ["@scope/tool"] });
    assert.equal(packageCount, 3);
    const store = join(to, "node_modules/.pnpm");
    assert.equal(existsSync(join(store, "unrelated@1.0.0")), false);
    const tool = realpathSync(join(to, "node_modules/@scope/tool"));
    assert.equal(tool, realpathSync(join(store, "@scope+tool@1.0.0/node_modules/@scope/tool")));
    assert.equal(
      realpathSync(join(store, "helper@2.0.0/node_modules/deep")),
      realpathSync(join(store, "deep@3.0.0/node_modules/deep"))
    );
    assert.ok(existsSync(join(store, "node_modules/deep/package.json")), "deep is hoisted");
    assert.deepEqual(
      commands.map(([command]) => command),
      ["tool", "tool-x"]
    );
    assert.equal(statSync(commands[0][1]).mode & 0o111, 0o111);
  });

  test("refuses a package that is missing or links outside the install", () => {
    const from = install("refuse");
    assert.throws(
      () => copyPackages({ from, to: join(scratch, "refuse-out"), names: ["absent"] }),
      /absent is not installed/u
    );
    const outside = join(scratch, "refuse-source");
    mkdirSync(outside);
    symlinkSync(outside, join(from, "node_modules/.pnpm/helper@2.0.0/node_modules/linked"));
    assert.throws(
      () => copyPackages({ from, to: join(scratch, "refuse-out-2"), names: ["@scope/tool"] }),
      /linked, a dependency in helper@2\.0\.0, links outside the install/u
    );
  });
});

// The apt and pip packages a stage installs.
function systemPackages(dockerfile, stage) {
  const lines = dockerfile.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^FROM \\S+ AS ${stage}$`, "u").test(line));
  assert.ok(start >= 0, `no stage ${stage}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("FROM "));
  const body = lines.slice(start, end < 0 ? undefined : end);
  const list = (marker) => {
    const from = body.findIndex((line) => line.includes(marker));
    assert.ok(from >= 0, `${stage} has no ${marker}`);
    const packages = [];
    for (const line of body.slice(from + 1)) {
      if (line.trim().startsWith("&&")) break;
      packages.push(line.replace(/\\$/u, "").trim());
    }
    return packages.sort();
  };
  return { apt: list("apt-get install"), pip: list("pip install") };
}

describe("the kit's Dockerfile", () => {
  const kitDockerfile = readFileSync(join(kitDir, "docker/deployment.Dockerfile"), "utf8");

  test("installs the system packages of the platform's artifact runtime", () => {
    const platformDockerfile = readFileSync(
      join(platformRoot, "docker/vivd-client.Dockerfile"),
      "utf8"
    );
    assert.deepEqual(
      systemPackages(kitDockerfile, "workspace-artifact-runtime"),
      systemPackages(platformDockerfile, "workspace-artifact-runtime")
    );
  });

  test("serves the interface with the platform's nginx configuration", () => {
    assert.equal(
      readFileSync(join(kitDir, "docker/nginx-spa.conf"), "utf8"),
      readFileSync(join(platformRoot, "docker/nginx-spa.conf"), "utf8")
    );
  });

  test("builds the six images of a release manifest", () => {
    const stages = [...kitDockerfile.matchAll(/^FROM \S+ AS (\S+)$/gmu)].map((match) => match[1]);
    for (const target of [
      "api",
      "ui",
      "doc-worker",
      "workspace-command-worker",
      "artifact-preview-worker",
      "runner"
    ]) {
      assert.ok(stages.includes(target), `no target ${target}`);
    }
  });
});
