import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

it.each([
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
