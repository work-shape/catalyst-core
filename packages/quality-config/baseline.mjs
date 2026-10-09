/**
 * @typedef {{ target: string, rule: string, scope: string }} Finding
 * @typedef {Finding & { count: number, owner: string }} BaselineEntry
 * @typedef {{ version: number, entries: BaselineEntry[] }} Baseline
 */

/** @param {Finding} finding */
const keyOf = (finding) => `${finding.target}|${finding.rule}|${finding.scope}`;

/**
 * Compares the measured findings of one target with its baseline entries. The counts must
 * match exactly: a rise is a new violation, a fall is a baseline that was not lowered.
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
      throw new Error("Invalid baseline entry");
    if (expected.has(keyOf(entry))) throw new Error(`Duplicate baseline entry: ${keyOf(entry)}`);
    expected.set(keyOf(entry), entry.count);
  }
  /** @type {Map<string, number>} */
  const actual = new Map();
  for (const finding of measured) actual.set(keyOf(finding), (actual.get(keyOf(finding)) ?? 0) + 1);
  const errors = [];
  for (const key of [...new Set([...actual.keys(), ...expected.keys()])].sort()) {
    if (key.split("|")[0] !== target) continue;
    const count = actual.get(key) ?? 0;
    const limit = expected.get(key) ?? 0;
    if (count !== limit)
      errors.push(
        `${key}: measured ${count}, baseline ${limit}${count < limit ? "; lower the baseline" : "; repair the increase"}`
      );
  }
  return errors;
}
