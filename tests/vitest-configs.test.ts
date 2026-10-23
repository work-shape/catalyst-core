import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { toolingFiles, testProjects } from "../vitest.projects.config";

it.each([
  ["vitest.tooling.config.ts", toolingFiles],
  ["vitest.upgrade.config.ts", ["tests/upgrade/oldest-supported-release.upgrade.ts"]],
  [
    "vitest.probes.config.ts",
    ["tests/probes/workflow-volume.probe.ts", "tests/workflow-worker-kill.test.ts"]
  ],
  ["vitest.records-live.config.ts", ["tests/data-store-chat.live.ts"]]
] as const)("%s discovers only its opt-in suite", (config, expected) => {
  const output = execFileSync(
    "pnpm",
    ["exec", "vitest", "list", "--filesOnly", "--json", "--config", config],
    { encoding: "utf8", env: { ...process.env, POSTGRES_STORE_TEST_DATABASE_URL: undefined } }
  );
  const files = z.array(z.object({ file: z.string() })).parse(JSON.parse(output));
  expect(
    files.map(({ file }) => relative(process.cwd(), file).replaceAll("\\", "/")).sort()
  ).toEqual([...expected].sort());
});

it("the product suite excludes exactly the tooling inventory, crash probe and opted-out scale files", () => {
  const output = execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly", "--json"], {
    encoding: "utf8",
    env: { ...process.env, POSTGRES_STORE_TEST_DATABASE_URL: undefined, CATALYST_SCALE_TESTS: "0" }
  });
  const files = z
    .array(z.object({ file: z.string(), projectName: z.string() }))
    .parse(JSON.parse(output));
  const discovered = files.map(({ file }) => relative(process.cwd(), file).replaceAll("\\", "/"));
  expect(discovered).not.toContain("tests/workflow-worker-kill.test.ts");
  for (const file of toolingFiles) expect(discovered).not.toContain(file);
  expect(discovered.some((file) => file.endsWith(".scale.test.ts"))).toBe(false);
  expect(new Set(files.map(({ projectName }) => projectName))).toEqual(
    new Set(["pure", "postgres", "isolated"])
  );
  const { pure, postgres, isolated } = testProjects(process.cwd());
  const expected = [...pure, ...postgres, ...isolated].filter(
    (file) =>
      !toolingFiles.includes(file) &&
      file !== "tests/workflow-worker-kill.test.ts" &&
      !file.endsWith(".scale.test.ts")
  );
  expect(discovered.sort()).toEqual(expected.sort());
});
