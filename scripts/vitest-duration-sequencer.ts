import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { balanceTests } from "./e2e-duration-shards.mjs";

const durations: { tests: Record<string, number> } = JSON.parse(
  readFileSync(new URL("../tests/durations.json", import.meta.url), "utf8")
);

/** Keep Vitest's discovery and execution; replace only its hash-based file allocation. */
export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const tests = files.map((spec) => ({
      key: relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/"),
      file: spec.moduleId,
      spec
    }));
    const selected = balanceTests(tests, durations.tests, shard.count)[shard.index - 1];
    if (!selected) throw new Error("Invalid Vitest shard index");
    const keys = new Set(selected.tests);
    console.log(
      `Vitest shard ${shard.index}/${shard.count}: ${keys.size}/${files.length} files, estimated ${selected.durationMs} ms`
    );
    return tests.filter((test) => keys.has(test.key)).map((test) => test.spec);
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Probe new files first, then long files, to avoid leaving an unknown long tail.
    return [...files].sort(
      (a, b) =>
        (durations.tests[relative(this.ctx.config.root, b.moduleId)] ?? Infinity) -
          (durations.tests[relative(this.ctx.config.root, a.moduleId)] ?? Infinity) ||
        a.moduleId.localeCompare(b.moduleId)
    );
  }
}
