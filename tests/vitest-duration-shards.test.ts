import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { balanceTests } from "../scripts/e2e-duration-shards.mjs";

const measured: { tests: Record<string, number> } = JSON.parse(
  readFileSync(new URL("./durations.json", import.meta.url), "utf8")
);
const files = readdirSync(new URL("./", import.meta.url), { recursive: true })
  .filter((file): file is string => typeof file === "string" && file.endsWith(".test.ts"))
  .map((file) => `tests/${file.replaceAll("\\", "/")}`);

describe("duration-based Vitest shards", () => {
  it("allocates every discovered file exactly once with deterministic balanced loads", () => {
    const tests = files.map((file) => ({ key: file, file }));
    const shards = balanceTests(tests, measured.tests, 4);
    const assigned = shards.flatMap((shard) => shard.tests);
    expect(assigned.sort()).toEqual([...files].sort());
    expect(new Set(assigned).size).toBe(files.length);
    expect(balanceTests([...tests].reverse(), measured.tests, 4)).toEqual(shards);
    const loads = shards.map((shard) => shard.durationMs);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(100);
  });

  it("gives an unknown file the median and rejects duplicate files", () => {
    const files = [{ key: "tests/new.test.ts", file: "tests/new.test.ts" }];
    expect(balanceTests(files, { fast: 1, median: 20, slow: 100 }, 1)[0]?.durationMs).toBe(20);
    expect(() => balanceTests([...files, ...files], { known: 20 }, 4)).toThrow("Duplicate");
  });

  it("refreshes Vitest file medians from hosted reports and refuses unsuccessful reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "vitest-durations-"));
    try {
      mkdirSync(join(dir, "tests"));
      const paths = [30, 10, 20].map((duration, index) => {
        const path = join(dir, `report-${index}.json`);
        writeFileSync(
          path,
          JSON.stringify({
            success: true,
            testResults: [
              {
                name: "/runner/repo/tests/example.test.ts",
                startTime: 100,
                endTime: 100 + duration
              }
            ]
          })
        );
        return path;
      });
      const script = fileURLToPath(
        new URL("../scripts/refresh-e2e-durations.mjs", import.meta.url)
      );
      const run = (...reports: string[]) =>
        spawnSync(process.execPath, [script, "--vitest", "38881299343", ...reports], { cwd: dir });
      expect(run(...paths).status).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "tests/durations.json"), "utf8"))).toEqual({
        sourceRuns: [38881299343],
        tests: { "tests/example.test.ts": 20 }
      });
      writeFileSync(paths[0] ?? "", JSON.stringify({ success: false }));
      expect(run(...paths).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
