/** The stable Playwright --test-list spelling; line numbers are deliberately omitted. */
export function reportTests(report) {
  const tests = [];
  function visit(suite, parents = []) {
    const titles = suite.file === suite.title ? parents : [...parents, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        tests.push({
          key: `[${test.projectName}] › ${spec.file} › ${[...titles, spec.title].join(" › ")}`,
          file: spec.file,
          results: test.results
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of report.suites) visit(suite);
  return tests;
}

/**
 * Longest work first. Every collected test goes to exactly one shard, including new titles.
 * Reserve at least half the average group count for each shard: stale long durations must
 * not leave a shard with just one test. A serial journey counts as one indivisible group.
 * Inbox is the suite's one explicitly serial file: keep its shared journey on one database.
 * @param {Array<{key: string, file: string}>} tests
 * @param {Record<string, number>} durations
 * @param {number} count
 * @returns {Array<{tests: string[], durationMs: number}>}
 */
export function balanceTests(tests, durations, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid browser shard count");
  const known = Object.values(durations)
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);
  if (!known.length) throw new Error("No measured browser durations");
  const median = known[Math.floor(known.length / 2)];
  const groups = new Map();
  const seen = new Set();
  for (const test of tests) {
    if (seen.has(test.key)) throw new Error(`Duplicate browser test: ${test.key}`);
    seen.add(test.key);
    const groupKey =
      test.file === "inbox.spec.ts" ? `[inbox] ${test.key.split(" › ")[0]}` : test.key;
    const group = groups.get(groupKey) ?? { key: groupKey, tests: [], durationMs: 0 };
    group.tests.push(test.key);
    group.durationMs += durations[test.key] > 0 ? durations[test.key] : median;
    groups.set(groupKey, group);
  }
  const shards = Array.from({ length: count }, () => ({ tests: [], durationMs: 0 }));
  const ordered = [...groups.values()].sort(
    (a, b) => b.durationMs - a.durationMs || a.key.localeCompare(b.key)
  );
  const floor = Math.min(
    Math.floor(groups.size / count),
    Math.max(1, Math.floor(groups.size / count / 2))
  );
  const groupCounts = new Map(shards.map((shard) => [shard, 0]));
  for (const [index, group] of ordered.entries()) {
    const deficit = shards.reduce(
      (sum, shard) => sum + Math.max(0, floor - groupCounts.get(shard)),
      0
    );
    const candidates =
      ordered.length - index <= deficit
        ? shards.filter((shard) => groupCounts.get(shard) < floor)
        : shards;
    const lightest = candidates.reduce((a, b) => (a.durationMs <= b.durationMs ? a : b));
    groupCounts.set(lightest, groupCounts.get(lightest) + 1);
    lightest.tests.push(...group.tests.sort());
    lightest.durationMs += group.durationMs;
  }
  return shards;
}
