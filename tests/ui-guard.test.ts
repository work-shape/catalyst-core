import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareBaseline, type Baseline } from "@work-shape/catalyst-quality-config/baseline";
import { isLibraryFile, scanUiGuard, uiGuardHints } from "./ui-guard-scan";

const platformRoot = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = fileURLToPath(new URL("../quality-baseline.json", import.meta.url));

/** The shared quality baseline rejects new findings; a count below its entry passes. */
describe("UI guard", () => {
  const findings = scanUiGuard(platformRoot);
  const baseline: Baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  it("stays within the shared quality baseline", () => {
    const measured = findings.map((finding) => ({
      target: "ui-guard",
      rule: finding.category,
      scope: finding.file.split("/").slice(0, 2).join("/"),
      file: finding.file
    }));
    const details = findings
      .map(
        (finding) =>
          `${finding.file}:${finding.line} ${finding.found}: ${uiGuardHints[finding.category]}`
      )
      .join("\n");
    expect(compareBaseline(measured, baseline, "ui-guard"), details).toEqual([]);
  });

  it("holds the library itself at zero", () => {
    expect(findings.filter((finding) => isLibraryFile(finding.file))).toEqual([]);
    expect(
      baseline.entries.filter(
        (entry) => entry.target === "ui-guard" && entry.scope === "packages/ui"
      )
    ).toEqual([]);
  });

  it("gives every transferred exception a reason", () => {
    expect(
      (baseline.acceptedRaises ?? []).filter(
        (entry) => entry.key.startsWith("ui-guard|") && entry.reason.trim().length < 20
      )
    ).toEqual([]);
  });
});
