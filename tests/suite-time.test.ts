import { describe, expect, it } from "vitest";
import { limitSeconds, suiteSeconds } from "../scripts/suite-time.mjs";

describe("the one time limit of the test suites", () => {
  it("reads Vitest's last Duration line, colours and all", () => {
    const log = [
      " \u001b[2m Test Files \u001b[22m 966 passed (968)",
      "\u001b[2m   Duration \u001b[22m 837.06s\u001b[2m (transform 147.56s, setup 2.11s)\u001b[22m"
    ].join("\n");
    expect(suiteSeconds("vitest", log)).toBeCloseTo(837.06);
    expect(suiteSeconds("vitest", "   Duration  1.5m (transform 1s)")).toBe(90);
    // A downloaded Actions log keeps the codes but drops their escape byte.
    expect(
      suiteSeconds("vitest", "[2m   Duration [22m 837.06s[2m (transform 147.56s)")
    ).toBeCloseTo(837.06);
  });

  it("reads Playwright's passed time in any unit", () => {
    expect(suiteSeconds("playwright", "  245 passed (6.2m)")).toBeCloseTo(372);
    expect(suiteSeconds("playwright", "  3 flaky\n  42 passed (45.3s)")).toBeCloseTo(45.3);
  });

  it("finds nothing in a log of a suite that did not finish", () => {
    expect(suiteSeconds("vitest", "FAIL tests/a.test.ts")).toBeUndefined();
    expect(suiteSeconds("playwright", "Error: browser closed")).toBeUndefined();
  });

  it("allows 15 minutes on 16 cores and scales by 16 / cores", () => {
    expect(limitSeconds(16)).toBe(900);
    expect(limitSeconds(10)).toBe(1440);
    expect(limitSeconds(4)).toBe(3600);
  });
});
