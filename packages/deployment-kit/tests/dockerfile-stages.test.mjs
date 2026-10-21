// Every stage a Dockerfile copies from, mounts from or builds on is defined before the stage
// that names it: BuildKit refuses a later one ("it needs to be defined before current stage"),
// and nothing builds these files before a deployment does. With CATALYST_DOCKER_CHECK=1 and a
// Docker daemon, `docker buildx build --check` reads each file as well: it resolves the base
// images over the network, so it is no part of the default run. `pnpm test:deployment-kit`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { dockerCheckAsked } from "../lib/env.mjs";

const root = resolve(import.meta.dirname, "../../..");
const DOCKERFILES = [
  "packages/deployment-kit/docker/deployment.Dockerfile",
  "docker/vivd-client.Dockerfile"
];

/**
 * The stages of a Dockerfile in order, each with the stages it names: its base and every
 * `--from=` of a COPY or a RUN mount. A name that is no stage, such as an image, is left out.
 */
export function stageReferences(text) {
  const lines = text.replace(/\\\r?\n/gu, " ").split(/\r?\n/u);
  const stages = [];
  for (const line of lines) {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/iu.exec(line);
    if (from) {
      stages.push({ name: from[2]?.toLowerCase(), base: from[1].toLowerCase(), uses: [] });
      continue;
    }
    const current = stages.at(-1);
    if (!current) continue;
    for (const match of line.matchAll(/--(?:from|mount=[^\s]*?\bfrom)=([^\s,]+)/giu)) {
      current.uses.push(match[1].toLowerCase());
    }
  }
  return stages;
}

/** Each stage named before it is defined, as "<stage> names <later stage>". */
export function laterStageReferences(text) {
  const stages = stageReferences(text);
  const position = new Map(
    stages.flatMap((stage, index) => (stage.name ? [[stage.name, index]] : []))
  );
  return stages.flatMap((stage, index) =>
    [stage.base, ...stage.uses]
      .filter((name) => position.has(name) && position.get(name) >= index)
      .map((name) => `${stage.name ?? `stage ${index}`} names ${name}`)
  );
}

describe("the stages of the Dockerfiles", () => {
  test("a stage defined later is refused, as BuildKit refuses it", () => {
    const text = [
      "FROM node:24 AS api",
      "COPY --from=system /a /a",
      "RUN --mount=type=cache,from=system,target=/b true",
      "FROM node:24 AS system",
      "FROM system AS runner",
      "COPY --from=api /c /c"
    ].join("\n");
    assert.deepEqual(laterStageReferences(text), ["api names system", "api names system"]);
  });

  for (const file of DOCKERFILES) {
    test(`${file} names only stages defined before it`, () => {
      const text = readFileSync(join(root, file), "utf8");
      assert.ok(stageReferences(text).length > 1);
      assert.deepEqual(laterStageReferences(text), []);
    });
  }

  const asked = dockerCheckAsked();
  const daemon = asked
    ? spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        encoding: "utf8",
        timeout: 10_000
      })
    : undefined;
  test(
    "docker buildx build --check reads each Dockerfile",
    {
      skip: !asked
        ? "CATALYST_DOCKER_CHECK is not 1"
        : daemon?.status === 0
          ? false
          : "no Docker daemon answers"
    },
    () => {
      // The check reads the file alone: an empty context sends nothing.
      const context = mkdtempSync(join(tmpdir(), "catalyst-dockerfile-check-"));
      try {
        for (const file of DOCKERFILES) {
          const check = spawnSync(
            "docker",
            ["buildx", "build", "--check", "-f", join(root, file), context],
            { encoding: "utf8", timeout: 120_000 }
          );
          assert.equal(check.status, 0, `${file}\n${check.stdout}\n${check.stderr}`);
        }
      } finally {
        rmSync(context, { recursive: true, force: true });
      }
    }
  );
});
