import { required } from "./support/assertions";
import { describe, expect, it } from "vitest";
import { balanceTests, reportTests } from "../scripts/e2e-duration-shards.mjs";

const test = (title: string, file = "chat.spec.ts") => ({
  key: `[chromium] › ${file} › ${title}`,
  file
});

describe("duration-based browser shards", () => {
  it("keeps every title exactly once, preserves serial journeys and balances measured work", () => {
    const tests = [
      test("a"),
      test("b"),
      test("c"),
      test("first", "inbox.spec.ts"),
      test("second", "inbox.spec.ts")
    ];
    const durations = Object.fromEntries(
      tests.map((test, index) => [test.key, required([90, 60, 30, 20, 10][index])])
    );
    const shards = balanceTests(tests, durations, 2);
    expect(shards.flatMap((shard) => shard.tests).sort()).toEqual(
      tests.map((test) => test.key).sort()
    );
    expect(shards.map((shard) => shard.durationMs)).toEqual([120, 90]);
    expect(shards.find((shard) => shard.tests.includes(required(tests[3]).key))?.tests).toContain(
      required(tests[4]).key
    );
    expect(balanceTests([...tests].reverse(), durations, 2)).toEqual(shards);
  });

  it("reserves a count floor when stale durations would strand nearly empty shards", () => {
    const tests = Array.from({ length: 36 }, (_, index) => test(`test ${index}`));
    const durations = Object.fromEntries(
      tests.map((test, index) => [test.key, index < 2 ? 100_000 : 10])
    );
    const shards = balanceTests(tests, durations, 6);
    expect(Math.min(...shards.map((shard) => shard.tests.length))).toBeGreaterThanOrEqual(3);
    expect(shards.flatMap((shard) => shard.tests).sort()).toEqual(
      tests.map((test) => test.key).sort()
    );
    expect(balanceTests([...tests].reverse(), durations, 6)).toEqual(shards);
  });

  it("fills every shard when there are only enough groups for one each", () => {
    const tests = Array.from({ length: 6 }, (_, index) => test(`test ${index}`));
    expect(balanceTests(tests, { measured: 10 }, 6).map((shard) => shard.tests.length)).toEqual([
      1, 1, 1, 1, 1, 1
    ]);
    expect(
      balanceTests(tests.slice(0, 2), { measured: 10 }, 6).flatMap((shard) => shard.tests)
    ).toHaveLength(2);
  });

  it("gives a new title the measured median and rejects duplicate identities", () => {
    const tests = [test("new")];
    expect(balanceTests(tests, { fast: 10, middle: 20, slow: 30 }, 1)[0]?.durationMs).toBe(20);
    expect(() => balanceTests([...tests, ...tests], { measured: 20 }, 2)).toThrow("Duplicate");
  });

  it("uses the collected project, file and nested titles without unstable line numbers", () => {
    const listed = reportTests({
      suites: [
        {
          title: "chat.spec.ts",
          file: "chat.spec.ts",
          suites: [
            {
              title: "journey",
              file: "chat.spec.ts",
              specs: [
                {
                  title: "ends",
                  file: "chat.spec.ts",
                  line: 123,
                  tests: [{ projectName: "chromium", results: [] }]
                }
              ]
            }
          ]
        }
      ]
    });
    expect(listed).toEqual([
      { key: "[chromium] › chat.spec.ts › journey › ends", file: "chat.spec.ts", results: [] }
    ]);
  });
});
