import { readFileSync } from "node:fs";
import { z } from "zod";

const exception = z.object({ measuredMs: z.number().positive(), reason: z.string().trim().min(1) });
const exceptions = z.record(z.string(), exception);
const schema = z.object({
  measuredAt: z.string(),
  source: z.string(),
  notes: z.string(),
  vitestFiles: exceptions,
  vitestTests: exceptions,
  browserFiles: exceptions
});
export type BudgetAllowlist = z.infer<typeof schema>;
export type DurationSample = { file: string; test?: string; durationMs: number };

export const allowlistPath = "scripts/test-duration-budget.allowlist.json";
export function readBudgetAllowlist(): BudgetAllowlist {
  return schema.parse(
    JSON.parse(readFileSync(new URL(`../${allowlistPath}`, import.meta.url), "utf8"))
  );
}

/** File exceptions never exempt individual tests; identities are exact, without wildcards. */
export function durationViolations(
  runner: "vitest" | "browser",
  samples: DurationSample[],
  allowlist = readBudgetAllowlist()
): string[] {
  return samples.flatMap(({ file, test, durationMs }) => {
    if (runner === "vitest" && file.endsWith(".scale.test.ts")) return [];
    const key = test === undefined ? file : `${file} > ${test}`;
    const limit = runner === "browser" ? 60_000 : test === undefined ? 20_000 : 5_000;
    const allowed =
      runner === "browser"
        ? allowlist.browserFiles
        : test === undefined
          ? allowlist.vitestFiles
          : allowlist.vitestTests;
    if (durationMs <= limit || Object.hasOwn(allowed, key)) return [];
    return [`${key}: ${(durationMs / 1000).toFixed(3)} s exceeds ${limit / 1000} s`];
  });
}

export function reportBudgetViolations(violations: string[]): boolean {
  if (!violations.length) return false;
  console.error(
    `TEST TIME BUDGET exceeded (a warning; the run does not fail):\n${violations.map((line) => `  ${line}`).join("\n")}\n` +
      `Reduce the cost or add the exact identity to ${allowlistPath} with measuredMs and a reason.`
  );
  return true;
}
