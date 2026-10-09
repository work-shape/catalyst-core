/**
 * @typedef {{ target: string, rule: string, scope: string, file?: string }} Finding
 * @typedef {Finding & { count: number, owner: string }} BaselineEntry
 * @typedef {{ version: number, entries: BaselineEntry[] }} Baseline
 */

/** @param {Finding} finding */
const keyOf = (finding) => `${finding.target}|${finding.rule}|${finding.scope}`;

/**
 * Compares the measured findings of one target with its baseline entries. The counts must
 * match exactly: a rise is a new violation, a fall is a baseline that was not lowered. A rise
 * names the files that hold the findings, because the count alone does not say where to look.
 * @param {Finding[]} measured
 * @param {Baseline} baseline
 * @param {string} target
 * @returns {string[]} One line per difference; empty when the target matches its baseline.
 */
export function compareBaseline(measured, baseline, target) {
  if (baseline.version !== 1 || !Array.isArray(baseline.entries))
    throw new Error("Invalid quality baseline");
  /** @type {Map<string, number>} */
  const expected = new Map();
  for (const entry of baseline.entries) {
    if (
      !entry.owner ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 1 ||
      !entry.rule ||
      !entry.scope ||
      !entry.target
    )
      throw new Error(`Invalid baseline entry: ${JSON.stringify(entry)}`);
    if (expected.has(keyOf(entry))) throw new Error(`Duplicate baseline entry: ${keyOf(entry)}`);
    expected.set(keyOf(entry), entry.count);
  }
  /** @type {Map<string, Finding[]>} */
  const actual = new Map();
  for (const finding of measured)
    actual.set(keyOf(finding), [...(actual.get(keyOf(finding)) ?? []), finding]);
  const errors = [];
  for (const key of [...new Set([...actual.keys(), ...expected.keys()])].sort()) {
    if (key.split("|")[0] !== target) continue;
    const found = actual.get(key) ?? [];
    const limit = expected.get(key) ?? 0;
    if (found.length < limit)
      errors.push(`${key}: measured ${found.length}, baseline ${limit}; lower the baseline`);
    if (found.length > limit)
      errors.push(
        `${key}: measured ${found.length}, baseline ${limit}; repair the increase${filesOf(found)}`
      );
  }
  return errors;
}

/**
 * The files that hold a set of findings, with the number of findings in each: the first ten.
 * @param {Finding[]} findings
 */
function filesOf(findings) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const { file } of findings) if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  if (counts.size === 0) return "";
  const names = [...counts.keys()].sort();
  const listed = names.slice(0, 10).map((file) => `${file} (${counts.get(file)})`);
  const more = names.length > 10 ? ` and ${names.length - 10} more` : "";
  return `. Findings are in ${listed.join(", ")}${more}`;
}

/**
 * The entries of a baseline that are new or whose count is higher than in an earlier baseline.
 * Entries are only added when a rule is introduced, with its measurement, so on a pull
 * request both are a baseline raised to admit a new violation.
 * @param {Baseline} earlier
 * @param {Baseline} current
 * @returns {string[]} One line per raised or added entry.
 */
export function baselineRises(earlier, current) {
  const before = new Map(earlier.entries.map((entry) => [keyOf(entry), entry.count]));
  return current.entries
    .filter((entry) => entry.count > (before.get(keyOf(entry)) ?? 0))
    .map((entry) =>
      before.has(keyOf(entry))
        ? `${keyOf(entry)}: count raised from ${before.get(keyOf(entry))} to ${entry.count}`
        : `${keyOf(entry)}: entry added with count ${entry.count}`
    )
    .sort();
}
