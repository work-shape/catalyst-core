import assert from "node:assert/strict";
import { parse } from "yaml";
import { publicLockfile } from "./mirror-lock.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { guard } from "./guard.mjs";
import { MIRRORED_PATHS, mirror } from "./mirror.mjs";
import { withPublishMetadata } from "./package-metadata.mjs";
import { verifyRestricted } from "./registry.mjs";
import { distributionTag, publish } from "./publish.mjs";
import { assertReleaseContext, releaseVersion } from "./context.mjs";

// Fixtures must never inherit authorization or step outputs from a real release job.
process.env.GITHUB_ACTIONS = "false";
delete process.env.GITHUB_OUTPUT;

const roots = [];
const write = (root, path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
};
function fixture(capabilities = false) {
  const root = mkdtempSync(join(tmpdir(), "catalyst-release-policy-"));
  roots.push(root);
  write(root, "package.json", {
    name: capabilities ? "vivd-catalyst-capabilities" : "vivd-catalyst",
    version: "0.7.0",
    private: true
  });
  for (const dir of capabilities
    ? ["artifact-helpers"]
    : ["api-contract", "core", "quality-config"]) {
    const manifest = {
      name: `@work-shape/catalyst-${dir}`,
      version: "0.7.0",
      type: "module",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          development: "./src/index.ts",
          import: "./dist/index.js"
        }
      }
    };
    write(
      root,
      `packages/${dir}/package.json`,
      dir === "quality-config"
        ? { ...manifest, private: true }
        : withPublishMetadata(dir, manifest, root)
    );
    write(root, `packages/${dir}/dist/index.js`, "export const version = '0.7.0';\n");
    write(root, `packages/${dir}/dist/index.d.ts`, "export declare const version: string;\n");
    if (dir === "api-contract") write(root, `packages/${dir}/LICENSE`, "MIT License\n");
  }
  return root;
}
function change(root, dir, update) {
  const path = `packages/${dir}/package.json`;
  const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
  update(manifest);
  write(root, path, manifest);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("guard accepts public/restricted packages and refuses a private package made public", () => {
  const root = fixture();
  assert.equal(guard([root]).length, 2);
  change(root, "core", (manifest) => {
    manifest.publishConfig.access = "public";
    manifest.license = "MIT";
  });
  assert.throws(() => guard([root]), /expected UNLICENSED and restricted/u);
});
test("guard refuses a public dependency on private code, including development dependencies", () => {
  const root = fixture();
  change(root, "api-contract", (manifest) => {
    manifest.devDependencies = { "@work-shape/catalyst-core": "workspace:*" };
  });
  assert.throws(() => guard([root]), /public package depends on private package/u);
});
test("guard includes private tooling and the paired repository in lockstep", () => {
  const root = fixture();
  const companion = fixture(true);
  assert.equal(guard([root, companion]).length, 3);
  change(root, "quality-config", (manifest) => {
    manifest.version = "0.1.0";
  });
  assert.throws(() => guard([root, companion]), /one current version/u);
});
test("standalone client assemblies stay private and participate in lockstep", () => {
  const root = fixture();
  const path = "clients/chat-standalone/package.json";
  const manifest = {
    name: "@work-shape/catalyst-chat-standalone",
    version: "0.7.0",
    private: true
  };
  write(root, path, manifest);
  assert.equal(guard([root]).length, 2);
  write(root, path, { ...manifest, private: false });
  assert.throws(() => guard([root]), /client assembly must be private/u);
  write(root, path, { ...manifest, version: "0.1.0" });
  assert.throws(() => guard([root]), /one current version/u);
});
test("server metadata ships vendor files and omits development-only test exports", () => {
  const root = fixture();
  const manifest = withPublishMetadata(
    "server",
    {
      name: "@work-shape/catalyst-server",
      version: "0.7.0",
      exports: {
        ".": { development: "./src/index.ts", import: "./dist/index.js" },
        "./testing": { development: "./src/testing.ts" }
      }
    },
    root
  );
  assert.deepEqual(manifest.files, ["dist", "vendor"]);
  assert.equal(manifest.repository.directory, "packages/server");
  assert.deepEqual(manifest.publishConfig.exports, { ".": { import: "./dist/index.js" } });
});
test("capabilities cannot opt a package into MIT or public access", () => {
  const root = fixture(true);
  change(root, "artifact-helpers", (manifest) => {
    manifest.publishConfig.access = "public";
  });
  assert.throws(() => guard([root]), /expected UNLICENSED and restricted/u);
});
test("release tags are strict and include unpublished manifests", () => {
  const root = fixture();
  assert.equal(releaseVersion(root, "v0.7.0"), "0.7.0");
  for (const tag of ["main", "v01.7.0", "v0.7.0\n", "v0.7.0-rc.01", "v0.7.0;bad"])
    assert.throws(() => releaseVersion(root, tag), /requires/u);
  assert.throws(() => releaseVersion(root, "v0.8.0-rc.1"), /match release tag/u);
  assert.throws(() => assertReleaseContext(root), /only allowed/u);
  change(root, "quality-config", (manifest) => {
    delete manifest.version;
  });
  assert.throws(() => releaseVersion(root, "v0.7.0"), /match release tag/u);
  assert.throws(() => guard([root]), /Every retained manifest/u);
});
test("candidate and older hotfix channels never move latest backwards", () => {
  assert.equal(distributionTag("0.8.0-rc.1", "0.7.0"), "next");
  assert.equal(distributionTag("0.7.1", "0.8.0"), "release-0.7");
  assert.equal(distributionTag("0.10.0", "0.9.0"), "latest");
  assert.equal(distributionTag("0.8.0", "0.8.0-rc.1"), "latest");
});
test("publish refuses a local non-dry-run before invoking npm", async () => {
  await assert.rejects(publish(["--root", fixture(), "--group", "restricted"]), /only allowed/u);
});
function mirrorFixture() {
  const source = fixture();
  const destination = mkdtempSync(join(tmpdir(), "catalyst-mirror-fixture-"));
  roots.push(destination);
  write(source, "tsconfig.base.json", {
    compilerOptions: {
      paths: {
        "@work-shape/catalyst-core": ["private.ts"],
        "@work-shape/catalyst-api-contract": ["packages/api-contract/src/index.ts"]
      }
    }
  });
  for (const dir of ["config-cli", "asset-schemas", "api-client"]) {
    const manifest = withPublishMetadata(
      dir,
      { name: `@work-shape/catalyst-${dir}`, version: "0.7.0" },
      source
    );
    write(source, `packages/${dir}/package.json`, manifest);
    write(source, `packages/${dir}/LICENSE`, "MIT License\n");
  }
  for (const file of [
    "package-metadata.mjs",
    "context.mjs",
    "registry.mjs",
    "publish.mjs",
    "guard.mjs",
    "versions.mjs"
  ]) {
    mkdirSync(join(source, "scripts/release"), { recursive: true });
    cpSync(new URL(file, import.meta.url), join(source, "scripts/release", file));
  }
  write(
    source,
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'
settings:
  autoInstallPeers: false
importers:
  .: {}
  packages/api-contract:
    dependencies:
      public-alias:
        specifier: npm:public-dependency@1.0.0
        version: public-dependency@1.0.0(peer@2.0.0)
  packages/api-client: {}
  packages/asset-schemas: {}
  packages/config-cli: {}
  packages/core:
    dependencies:
      core-only:
        specifier: 3.0.0
        version: 3.0.0
packages:
  public-dependency@1.0.0: {resolution: {integrity: public}}
  peer@2.0.0: {resolution: {integrity: peer}}
  optional@4.0.0: {resolution: {integrity: optional}}
  core-only@3.0.0: {resolution: {integrity: private}}
snapshots:
  public-dependency@1.0.0(peer@2.0.0):
    dependencies: {peer: 2.0.0}
    optionalDependencies: {optional: 4.0.0}
  peer@2.0.0: {}
  optional@4.0.0: {}
  core-only@3.0.0: {}
`
  );
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  git("init");
  git("add", ".");
  write(source, "packages/api-contract/.env", "untracked-private-input");
  for (const file of ["README.md", "LICENSE", "SECURITY.md"])
    write(
      source,
      `scripts/release/public/${file}`,
      file === "README.md" ? "Public introduction" : "Approved public asset"
    );
  write(source, "scripts/release/public/publish.yml", "public workflow");
  write(source, "scripts/release/public/examples/example.md", "public example");
  write(source, "scripts/release/public/docs/images/chat.jpg", "public image");
  cpSync(
    new URL("public/package-metadata.mjs", import.meta.url),
    join(source, "scripts/release/public/package-metadata.mjs")
  );
  return { source, destination };
}

test("mirror carries only tracked public folders and approved release docs/workflow", () => {
  const { source, destination } = mirrorFixture();
  write(destination, "changes/unreleased/feat-vp3-public-release.md", "stale change");
  write(destination, "scripts/release/obsolete.mjs", "stale helper");
  write(destination, "README.md", "stale introduction");
  write(destination, "docs/images/obsolete.jpg", "stale image");
  write(destination, ".github/workflows/publish.yml", "public workflow");
  mirror(source, destination);
  assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "Public introduction");
  assert.equal(readFileSync(join(destination, "docs/images/chat.jpg"), "utf8"), "public image");
  assert.throws(() => readFileSync(join(destination, "docs/images/obsolete.jpg")));
  assert.equal(
    readFileSync(join(destination, ".github/workflows/publish.yml"), "utf8"),
    "public workflow"
  );
  assert.throws(() => readFileSync(join(destination, "packages/core/package.json")));
  assert.throws(() => readFileSync(join(destination, "packages/api-contract/.env")));
  assert.equal(readFileSync(join(destination, ".npmrc"), "utf8"), "auto-install-peers=false\n");
  const lock = parse(readFileSync(join(destination, "pnpm-lock.yaml"), "utf8"));
  assert.deepEqual(Object.keys(lock.packages).sort(), [
    "optional@4.0.0",
    "peer@2.0.0",
    "public-dependency@1.0.0"
  ]);
  assert.deepEqual(Object.keys(lock.snapshots).sort(), [
    "optional@4.0.0",
    "peer@2.0.0",
    "public-dependency@1.0.0(peer@2.0.0)"
  ]);
  assert.equal(lock.importers["packages/core"], undefined);
  assert.doesNotMatch(
    readFileSync(join(destination, "scripts/release/package-metadata.mjs"), "utf8"),
    /catalyst-core|catalyst-capabilities|postgres-store|chat-ui/u
  );
  assert.throws(() =>
    readFileSync(join(destination, "changes/unreleased/feat-vp3-public-release.md"))
  );
  assert.throws(() => readFileSync(join(destination, "scripts/release/obsolete.mjs")));
  execFileSync(process.execPath, [join(destination, "scripts/release/guard.mjs")], {
    stdio: "pipe"
  });
  assert.doesNotMatch(readFileSync(join(destination, "tsconfig.base.json"), "utf8"), /private.ts/u);
});

test("mirror release commit stages docs, including removed images", () => {
  const { source, destination } = mirrorFixture();
  const git = (...args) =>
    execFileSync("git", args, { cwd: destination, encoding: "utf8", stdio: "pipe" }).trim();
  git("init");
  write(destination, "docs/images/obsolete.jpg", "stale image");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "seed");
  mirror(source, destination);
  git("add", "--", ...MIRRORED_PATHS);
  assert.deepEqual(git("ls-files", "docs").split("\n"), ["docs/images/chat.jpg"]);
  assert.equal(
    git("status", "--porcelain", "--", "docs"),
    "A  docs/images/chat.jpg\nD  docs/images/obsolete.jpg"
  );
});

test("mirror refuses a symlink in the release assets before touching the destination", () => {
  const { source, destination } = mirrorFixture();
  const outside = join(mkdtempSync(join(tmpdir(), "catalyst-mirror-outside-")), "secret.txt");
  roots.push(dirname(outside));
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(source, "scripts/release/public/docs/images/outside.txt"));
  write(destination, "README.md", "previous introduction");
  assert.throws(
    () => mirror(source, destination),
    /Mirror refuses symlink scripts\/release\/public\/docs\/images\/outside\.txt/u
  );
  assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "previous introduction");
});

test("CI context rejects an unapproved branch or a red Check and accepts a green tag", () => {
  const root = fixture();
  const bin = join(root, "bin");
  write(
    root,
    "bin/git",
    `#!/usr/bin/env node
if (process.argv[2] === 'branch') console.log(process.env.FIXTURE_BRANCH || 'origin/main');
else console.log('0123456789abcdef');
`
  );
  write(
    root,
    "bin/gh",
    `#!/usr/bin/env node
console.log(JSON.stringify({workflow_runs:[{head_sha:'0123456789abcdef',event:'push',head_branch:'main',status:'completed',conclusion:process.env.FIXTURE_CHECK || 'success'}]}));
`
  );
  execFileSync("chmod", ["+x", join(bin, "git"), join(bin, "gh")]);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_ACTIONS: "true",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v0.7.0",
    GITHUB_REPOSITORY: "work-shape/catalyst-core"
  };
  const run = (extra) =>
    execFileSync(
      process.execPath,
      [new URL("context.mjs", import.meta.url).pathname, "--root", root],
      { env: { ...env, ...extra }, stdio: "pipe" }
    );
  assert.match(run({}).toString(), /eligible/u);
  assert.throws(() => run({ FIXTURE_BRANCH: "origin/feature/unreviewed" }), /main or release/u);
  assert.throws(() => run({ FIXTURE_CHECK: "failure" }), /successful Check/u);
  assert.throws(() => run({ GITHUB_REF_TYPE: "branch" }), /release tag/u);
});

test("npm lookup distinguishes 404 from auth errors; rerun skips existing public versions", () => {
  const root = fixture();
  write(
    root,
    "bin/git",
    "#!/usr/bin/env node\nconsole.log(process.argv[2] === 'branch' ? 'origin/main' : '0123456789abcdef');\n"
  );
  write(
    root,
    "bin/npm",
    `#!/usr/bin/env node
if (process.argv[2] === 'dist-tag' && process.argv[3] === 'add') process.exit(0);
if (process.argv[2] !== 'view') { console.error('Unexpected publish'); process.exit(99); }
if (process.env.FIXTURE_ERROR) { console.log(JSON.stringify({error:{code:process.env.FIXTURE_ERROR}})); process.exit(1); }
console.log(JSON.stringify('0.7.0'));
`
  );
  execFileSync("chmod", ["+x", join(root, "bin/git"), join(root, "bin/npm")]);
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GITHUB_ACTIONS: "true",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v0.7.0",
    GITHUB_REPOSITORY: "work-shape/catalyst"
  };
  const registry = new URL("registry.mjs", import.meta.url).href;
  const code = `import { npmView } from ${JSON.stringify(registry)}; console.log(npmView('@work-shape/catalyst-api-contract', 'version'));`;
  const run = (error) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...env, FIXTURE_ERROR: error },
      stdio: "pipe"
    });
  assert.equal(run("E404").toString().trim(), "undefined");
  assert.throws(() => run("E401"), /refusing to treat it as absent/u);
  const output = execFileSync(
    process.execPath,
    [new URL("publish.mjs", import.meta.url).pathname, "--root", root, "--group", "public"],
    { env, stdio: "pipe" }
  );
  assert.match(output.toString(), /Already published/u);
});

test("privacy verification is anonymous and refuses a public name", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "error");
      return new Response("{}", { status: 404 });
    };
    await verifyRestricted([{ name: "@work-shape/catalyst-private-fixture" }]);
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    await assert.rejects(
      verifyRestricted([{ name: "@work-shape/catalyst-private-fixture" }]),
      /immediately run npm access/u
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("mirror rerun resumes its existing tag and refuses a tag from another core commit", () => {
  const root = fixture();
  mkdirSync(join(root, "destination/.git"), { recursive: true });
  const version = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ).version;
  write(
    root,
    "bin/git",
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') console.log('0123456789abcdef');
else if (args[0] === 'branch') console.log('origin/main');
else if (args[0] === 'remote') console.log('git@github.com:work-shape/catalyst.git');
else if (args[0] === 'status') process.exit(0);
else if (args[0] === 'tag' && args[1] === '--list') console.log(process.env.GITHUB_REF_NAME);
else if (args[0] === 'show') console.log('Core-Commit: ' + (process.env.FIXTURE_COMMIT || '0123456789abcdef'));
else { console.error('Unexpected git mutation'); process.exit(99); }
`
  );
  write(
    root,
    "bin/gh",
    `#!/usr/bin/env node
console.log(JSON.stringify({workflow_runs:[{head_sha:'0123456789abcdef',event:'push',head_branch:'main',status:'completed',conclusion:'success'}]}));
`
  );
  execFileSync("chmod", ["+x", join(root, "bin/git"), join(root, "bin/gh")]);
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GITHUB_ACTIONS: "true",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: `v${version}`,
    GITHUB_REPOSITORY: "work-shape/catalyst-core"
  };
  const run = (extra) =>
    execFileSync(
      process.execPath,
      [new URL("mirror.mjs", import.meta.url).pathname, join(root, "destination")],
      { env: { ...env, ...extra }, stdio: "pipe" }
    );
  assert.match(run({}).toString(), /already tagged/u);
  assert.throws(() => run({ FIXTURE_COMMIT: "different" }), /different core commit/u);
});

test("mirror lock refuses missing resolutions and links outside public packages", () => {
  const lock = {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: false },
    importers: Object.fromEntries(
      ["api-contract", "api-client", "asset-schemas", "config-cli"].map((dir) => [
        `packages/${dir}`,
        {}
      ])
    ),
    packages: {},
    snapshots: {}
  };
  lock.importers["packages/api-contract"] = { dependencies: { bad: { version: "1.0.0" } } };
  assert.throws(() => publicLockfile(JSON.stringify(lock)), /Missing public dependency snapshot/u);
  lock.importers["packages/api-contract"].dependencies.bad.version = "link:../core";
  assert.throws(() => publicLockfile(JSON.stringify(lock)), /outside the public workspace/u);
  assert.throws(() => publicLockfile("not: [valid"));
});

test("candidate cleanup tolerates sole-version refusal, repairs reruns, and only finals explicitly set latest", () => {
  const root = fixture();
  write(
    root,
    "bin/git",
    "#!/usr/bin/env node\nconsole.log(process.argv[2] === 'branch' ? 'origin/main' : '0123456789abcdef');\n"
  );
  write(
    root,
    "bin/npm",
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = process.env.FIXTURE_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
appendFileSync(file + '.calls', JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  const value = args[2] === 'versions' ? (state.versions ?? [state.version]) : args[2] === 'version' ? state.version : state.latest;
  if (value) console.log(JSON.stringify(value));
  else if (args[2] === 'version') { console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1); }
} else if (args[0] === 'publish') {
  state.version = process.env.FIXTURE_VERSION;
  state.latest ??= state.version; // emulate the first-publish registry quirk
} else if (args[0] === 'dist-tag' && args[1] === 'rm') {
  if (state.refuseCleanup) process.exit(1);
  delete state.latest;
}
else if (args[0] === 'dist-tag' && args[1] === 'add') state.latest = process.env.FIXTURE_VERSION;
else process.exit(99);
writeFileSync(file, JSON.stringify(state));
`
  );
  // Pack a real manifest/tarball with pnpm; every registry operation stays in the stub.
  execFileSync("chmod", ["+x", join(root, "bin/git"), join(root, "bin/npm")]);
  const state = join(root, "state.json");
  const run = (version) => {
    for (const path of [
      "package.json",
      "packages/api-contract/package.json",
      "packages/core/package.json",
      "packages/quality-config/package.json"
    ]) {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
      manifest.version = version;
      write(root, path, manifest);
    }
    const result = spawnSync(
      process.execPath,
      [new URL("publish.mjs", import.meta.url).pathname, "--root", root, "--group", "public"],
      {
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          GITHUB_ACTIONS: "true",
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: `v${version}`,
          GITHUB_REPOSITORY: "work-shape/catalyst",
          FIXTURE_STATE: state,
          FIXTURE_VERSION: version
        },
        stdio: "pipe",
        encoding: "utf8"
      }
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stderr;
  };
  run("0.8.0-rc.1");
  assert.equal(JSON.parse(readFileSync(state, "utf8")).latest, undefined);
  let calls = readFileSync(state + ".calls", "utf8");
  assert.match(calls, /"--tag","next"/u);
  assert.match(calls, /"dist-tag","rm"/u);
  assert.doesNotMatch(calls, /"dist-tag","add"/u);
  write(root, "state.json", { version: "0.8.0-rc.1", latest: "0.8.0-rc.1" });
  write(root, "state.json.calls", "");
  run("0.8.0-rc.1");
  assert.equal(JSON.parse(readFileSync(state, "utf8")).latest, undefined);
  assert.doesNotMatch(readFileSync(state + ".calls", "utf8"), /"publish"/u);
  // A brand-new name may require latest to exist. Both publication and reruns must finish.
  write(root, "state.json", { refuseCleanup: true });
  write(root, "state.json.calls", "");
  assert.match(
    run("0.8.0-rc.1"),
    /leaving latest on 0\.8\.0-rc\.1; npm refused cleanup of its only version/u
  );
  assert.equal(JSON.parse(readFileSync(state, "utf8")).latest, "0.8.0-rc.1");
  assert.match(readFileSync(state + ".calls", "utf8"), /"publish"/u);
  write(root, "state.json.calls", "");
  assert.match(run("0.8.0-rc.1"), /leaving latest on 0\.8\.0-rc\.1/u);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).latest, "0.8.0-rc.1");
  calls = readFileSync(state + ".calls", "utf8");
  assert.doesNotMatch(calls, /"publish"|"dist-tag","add"/u);
  assert.match(calls, /"versions"/u);
  // Permission/registry failures on an established name must still fail the release.
  write(root, "state.json", {
    version: "0.8.0-rc.1",
    latest: "0.8.0-rc.1",
    versions: ["0.7.0", "0.8.0-rc.1"],
    refuseCleanup: true
  });
  assert.throws(() => run("0.8.0-rc.1"));
  write(root, "state.json", { version: "0.8.0-rc.1", latest: "0.8.0-rc.1" });
  run("0.8.0");
  assert.equal(JSON.parse(readFileSync(state, "utf8")).latest, "0.8.0");
  assert.match(
    readFileSync(state + ".calls", "utf8"),
    /"dist-tag","add","@work-shape\/catalyst-api-contract@0.8.0","latest"/u
  );
  write(root, "state.json.calls", "");
  run("0.7.1");
  assert.equal(JSON.parse(readFileSync(state, "utf8")).latest, "0.8.0");
  calls = readFileSync(state + ".calls", "utf8");
  assert.match(calls, /"--tag","release-0.7"/u);
  assert.doesNotMatch(calls, /"dist-tag","add"/u);
});
