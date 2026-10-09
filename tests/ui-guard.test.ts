import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countUiGuardFindings,
  isLibraryFile,
  scanUiGuard,
  uiGuardHints,
  type UiGuardCategory,
  type UiGuardFinding
} from "./ui-guard-scan";

type Counts = Record<string, Partial<Record<UiGuardCategory, number>>>;

interface KeptEntry {
  file: string;
  category: UiGuardCategory;
  count: number;
  /** Why this stays. A new entry needs the design lead's yes in review. */
  reason: string;
}

interface Baseline {
  kept: KeptEntry[];
  /** What is left to move onto the library: one line per file. A number here only ever falls. */
  counts: Counts;
}

const platformRoot = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = fileURLToPath(new URL("./ui-guard.baseline.json", import.meta.url));

/**
 * Holds interface code to the shared UI library. Outside the library it counts what the library
 * replaces: raw form elements and dialogs, overlay roles, colours and sizes that bypass the
 * tokens, and overlay packages. Inside the library the same colours and sizes are held at zero,
 * and the library may import only its allow-list, keep nothing in storage and show no text of
 * its own.
 *
 * Every count must equal its baseline line: above fails, and below fails too, so a stale line
 * cannot hide a later rise. `UPDATE_UI_GUARD=1 pnpm vitest run tests/ui-guard.test.ts` lowers
 * the lines to what is measured. It never raises one.
 */
describe("UI guard", () => {
  const findings = scanUiGuard(platformRoot);
  const measured = countUiGuardFindings(findings);

  it("matches the baseline exactly", () => {
    const baseline = readBaseline();
    const expected = expectedCounts(baseline);
    if (process.env.UPDATE_UI_GUARD === "1") {
      writeBaseline({ kept: baseline.kept, counts: loweredCounts(baseline, measured) });
    }
    const current = process.env.UPDATE_UI_GUARD === "1" ? expectedCounts(readBaseline()) : expected;

    expect(differences(current, measured, findings)).toEqual([]);
  });

  it("holds the library itself at zero outside the kept list", () => {
    const baseline = readBaseline();

    expect(Object.keys(baseline.counts).filter(isLibraryFile)).toEqual([]);
  });

  it("gives every kept entry a reason", () => {
    expect(readBaseline().kept.filter((entry) => entry.reason.trim().length < 20)).toEqual([]);
  });
});

function readBaseline(): Baseline {
  const baseline: Baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  return baseline;
}

/** One line per file, so a diff shows exactly which file moved. */
function writeBaseline(baseline: Baseline): void {
  const kept = baseline.kept.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n");
  const counts = Object.entries(baseline.counts)
    .map(([file, fileCounts]) => `    ${JSON.stringify(file)}: ${JSON.stringify(fileCounts)}`)
    .join(",\n");
  writeFileSync(
    baselinePath,
    `{\n  "kept": [\n${kept}\n  ],\n  "counts": {\n${counts}\n  }\n}\n`,
    "utf8"
  );
}

function expectedCounts(baseline: Baseline): Counts {
  const expected: Counts = {};
  for (const [file, fileCounts] of Object.entries(baseline.counts)) {
    expected[file] = { ...fileCounts };
  }
  for (const entry of baseline.kept) {
    const fileCounts = (expected[entry.file] ??= {});
    fileCounts[entry.category] = (fileCounts[entry.category] ?? 0) + entry.count;
  }
  return expected;
}

/** The baseline with every line lowered to what is measured, and never raised. */
function loweredCounts(baseline: Baseline, measured: Counts): Counts {
  const lowered: Counts = {};
  for (const [file, fileCounts] of Object.entries(baseline.counts)) {
    const next: Partial<Record<UiGuardCategory, number>> = {};
    for (const [category, count] of categoryEntries(fileCounts)) {
      const kept = baseline.kept
        .filter((entry) => entry.file === file && entry.category === category)
        .reduce((sum, entry) => sum + entry.count, 0);
      const now = Math.max(0, (measured[file]?.[category] ?? 0) - kept);
      if (Math.min(count, now) > 0) {
        next[category] = Math.min(count, now);
      }
    }
    if (Object.keys(next).length > 0) {
      lowered[file] = next;
    }
  }
  return lowered;
}

function differences(
  expected: Counts,
  measured: Counts,
  findings: readonly UiGuardFinding[]
): string[] {
  const messages: string[] = [];
  const files = [...new Set([...Object.keys(expected), ...Object.keys(measured)])].sort();
  for (const file of files) {
    const categories = new Set([
      ...categoryEntries(expected[file] ?? {}).map(([category]) => category),
      ...categoryEntries(measured[file] ?? {}).map(([category]) => category)
    ]);
    for (const category of categories) {
      const allowed = expected[file]?.[category] ?? 0;
      const found = measured[file]?.[category] ?? 0;
      if (found > allowed) {
        const where = findings
          .filter((finding) => finding.file === file && finding.category === category)
          .map((finding) => `${finding.file}:${finding.line} ${finding.found}`)
          .join("\n  ");
        messages.push(
          `${file}: ${category} is ${found}, the baseline allows ${allowed}. ${uiGuardHints[category]}\n  ${where}`
        );
      } else if (found < allowed) {
        messages.push(
          `${file}: ${category} fell from ${allowed} to ${found}. Lower the baseline: UPDATE_UI_GUARD=1 pnpm vitest run tests/ui-guard.test.ts`
        );
      }
    }
  }
  return messages;
}

function categoryEntries(
  counts: Partial<Record<UiGuardCategory, number>>
): [UiGuardCategory, number][] {
  const categories: readonly UiGuardCategory[] = [
    "elements",
    "roles",
    "palette",
    "hex",
    "font-size",
    "radius",
    "overlay-imports",
    "library-imports",
    "library-storage",
    "library-text"
  ];
  return categories.flatMap((category) => {
    const count = counts[category];
    return count === undefined ? [] : [[category, count]];
  });
}
