#!/usr/bin/env node
// Replay the remaining freeze-C moves on a clean sibling checkout set. No installs or Git writes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const workspace = resolve(process.argv[2] ?? ".");
const platform = resolve(workspace, "platform");
if (!existsSync(resolve(platform, "packages/chat-server/package.json")))
  throw new Error("Expected pre-C-rest platform/packages/chat-server; replay onto a clean base");
const repos = [
  "platform",
  "capabilities",
  "deployment.catalyst",
  "deployment.musterbau",
  "deployment.exampletax"
]
  .map((name) => resolve(workspace, name))
  .filter((path) => existsSync(resolve(path, ".git")));
const read = (path) => readFileSync(path, "utf8");
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const json = (path) => JSON.parse(read(path));
const putJson = (path, value) => write(path, JSON.stringify(value, null, 2) + "\n");
const move = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
};
const at = (path) => resolve(platform, path);
move(at("packages/chat-server"), at("packages/server"));
move(at("packages/chat-standalone"), at("clients/chat-standalone"));
move(at("packages/data-source/src/index.ts"), at("packages/postgres-connector/src/data-source.ts"));
write(
  at("packages/postgres-connector/src/index.ts"),
  read(at("packages/postgres-connector/src/index.ts")) + '\nexport * from "./data-source";\n'
);
move(at("packages/chat-widget/src/index.tsx"), at("packages/chat-ui/src/widget.tsx"));
write(
  at("packages/chat-ui/src/widget.tsx"),
  read(at("packages/chat-ui/src/widget.tsx")).replace(
    "@work-shape/catalyst-chat-ui/shell",
    "./shell"
  )
);
move(
  at("packages/document-execution/src/index.ts"),
  at("packages/tool-execution/src/native-document.ts")
);
write(
  at("packages/tool-execution/src/env.ts"),
  read(at("packages/tool-execution/src/env.ts")) +
    "\n" +
    read(at("packages/document-execution/src/env.ts"))
);
for (const path of [
  "packages/data-source",
  "packages/chat-widget",
  "packages/document-execution",
  "packages/registry-canary",
  "scripts/deployment-kit",
  ".github/workflows/mirror-images.yml",
  ".github/mirrored-images",
  ".github/scripts/mirror-images.sh"
])
  rmSync(at(path), { recursive: true, force: true });
const forwarders = {
  "compose-watch-preflight.mjs": "dev/compose-watch-preflight.mjs",
  "ensure-compose-dev-images.mjs": "dev/ensure-compose-dev-images.mjs",
  "verify-compose-helpers.mjs": "verify/compose-helpers.mjs",
  "check-release.sh": "lib/check-release.sh",
  "update-release.sh": "lib/update-release.sh",
  "prepare-build-workspace.sh": "lib/prepare-build-workspace.sh"
};
const packageName = (name) =>
  name
    .replace("@work-shape/catalyst-data-source", "@work-shape/catalyst-postgres-connector")
    .replace("@work-shape/catalyst-document-execution", "@work-shape/catalyst-tool-execution");
for (const repo of repos) {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: repo,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    const path = resolve(repo, file);
    if (!existsSync(path) || /(?:^|\/)(?:pnpm-lock\.yaml|replay-c-rest\.mjs)$/.test(file)) continue;
    const buffer = readFileSync(path);
    if (buffer.includes(0)) continue;
    let text = buffer.toString("utf8");
    // Maps and manifests need key removal/merging before the textual import rewrite.
    if (file.endsWith("package.json")) {
      const pkg = JSON.parse(text);
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies"
      ]) {
        if (!pkg[field]) continue;
        pkg[field] = Object.fromEntries(
          Object.entries(pkg[field]).map(([name, version]) => [packageName(name), version])
        );
      }
      delete pkg.dependencies?.[pkg.name];
      text = JSON.stringify(pkg, null, 2) + "\n";
    }
    if (file === "quality-package-graph.json") {
      const graph = {};
      for (const [name, edges] of Object.entries(JSON.parse(text))) {
        if (
          [
            "@work-shape/catalyst-chat-widget",
            "@work-shape/catalyst-document-execution",
            "@work-shape/catalyst-data-source",
            "@vivd-solutions/registry-canary"
          ].includes(name)
        )
          continue;
        graph[name] = [...new Set(edges.map(packageName))].filter((edge) => edge !== name);
      }
      if (repo === platform)
        graph["@work-shape/catalyst-postgres-connector"].push("@work-shape/catalyst-tool-sdk");
      text = JSON.stringify(graph, null, 2) + "\n";
    }
    if (file === "tsconfig.base.json") {
      const config = JSON.parse(text);
      for (const name of [
        "@work-shape/catalyst-data-source",
        "@work-shape/catalyst-document-execution"
      ])
        delete config.compilerOptions.paths[name];
      const prefix = repo === platform ? "" : "../platform/";
      config.compilerOptions.paths["@work-shape/catalyst-postgres-connector"] = [
        prefix + "packages/postgres-connector/src/index.ts"
      ];
      config.compilerOptions.paths["@work-shape/catalyst-tool-execution/native-document"] = [
        prefix + "packages/tool-execution/src/native-document.ts"
      ];
      if (repo === platform)
        config.compilerOptions.paths["@work-shape/catalyst-chat-ui/widget"] = [
          "packages/chat-ui/src/widget.tsx"
        ];
      text = JSON.stringify(config, null, 2) + "\n";
    }
    if (file === "vitest.config.ts") {
      text = text.replace(
        /^\s*"@work-shape\/catalyst-(?:data-source|document-execution|chat-widget)":\s*"[^"]+",?\n/gm,
        "\n"
      );
      const prefix = repo === platform ? "" : "../platform/";
      text = text.replace(
        "const sourceAlias = {",
        "const sourceAlias = {\n" +
          `  "@work-shape/catalyst-tool-execution/native-document": "${prefix}packages/tool-execution/src/native-document.ts",\n` +
          (repo === platform
            ? '  "@work-shape/catalyst-chat-ui/widget": "packages/chat-ui/src/widget.tsx",\n'
            : `  "@work-shape/catalyst-postgres-connector": "${prefix}packages/postgres-connector/src/index.ts",\n`)
      );
    }
    text = text
      .replaceAll("packages/chat-server", "packages/server")
      .replaceAll("chat-server/src/", "server/src/")
      .replaceAll("packages/chat-standalone", "clients/chat-standalone")
      .replaceAll("packages/chat-widget/src/index.tsx", "packages/chat-ui/src/widget.tsx")
      .replaceAll("@work-shape/catalyst-data-source", "@work-shape/catalyst-postgres-connector")
      .replaceAll(
        "@work-shape/catalyst-document-execution",
        "@work-shape/catalyst-tool-execution/native-document"
      )
      .replaceAll("@work-shape/catalyst-chat-widget", "@work-shape/catalyst-chat-ui/widget");
    for (const [from, to] of Object.entries(forwarders))
      text = text.replaceAll("scripts/deployment-kit/" + from, "packages/deployment-kit/" + to);
    text = text.replaceAll("platform/scripts/deployment-kit/", "platform/packages/deployment-kit/");
    if (text !== buffer.toString("utf8")) write(path, text);
  }
}
// Fold-only public entries preserve the existing contracts without forwarding packages.
const connector = json(at("packages/postgres-connector/package.json"));
connector.dependencies["@work-shape/catalyst-tool-sdk"] = "workspace:*";
putJson(at("packages/postgres-connector/package.json"), connector);
for (const [dir, entry] of [
  ["chat-ui", "widget"],
  ["tool-execution", "native-document"]
]) {
  const path = at(`packages/${dir}/package.json`);
  const pkg = json(path);
  pkg.exports[`./${entry}`] = {
    types: `./dist/${entry}.d.ts`,
    development: `./src/${entry}.${dir === "chat-ui" ? "tsx" : "ts"}`,
    import: `./dist/${entry}.js`
  };
  pkg.publishConfig.exports[`./${entry}`] = {
    types: `./dist/${entry}.d.ts`,
    import: `./dist/${entry}.js`
  };
  pkg.scripts.build = pkg.scripts.build.replace(
    " --format",
    ` src/${entry}.${dir === "chat-ui" ? "tsx" : "ts"} --format`
  );
  putJson(path, pkg);
}
// Baseline findings follow their implementation into the owning package.
const baselinePath = at("quality-baseline.json");
const baseline = json(baselinePath);
for (const entry of baseline.entries) {
  if (entry.scope === "packages/document-execution") entry.scope = "packages/tool-execution";
  if (entry.scope === "packages/data-source") entry.scope = "packages/postgres-connector";
}
const entries = [];
for (const entry of baseline.entries) {
  const prior = entries.find(
    (other) =>
      other.target === entry.target && other.rule === entry.rule && other.scope === entry.scope
  );
  if (prior) prior.count += entry.count;
  else entries.push(entry);
}
baseline.entries = entries;
putJson(baselinePath, baseline);
console.log(
  "C-rest moves applied. Apply the separate hand-fix commit, regenerate lockfiles and run checks."
);
