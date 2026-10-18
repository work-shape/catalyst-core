import { describe, expect, it } from "vitest";
import { recordEvidence } from "@work-shape/catalyst-core";

describe("PROC-2 evidence boundary", () => {
  it("check 83: every accepted value parses from an exact quote on its cited page", () => {
    const page = "Kaufpreis 12.500 EUR. Fläche 120,5 m². Datum 18.10.2026.";
    expect(recordEvidence(12500, "Kaufpreis 12.500 EUR", page)).toEqual({ status: "passed" });
    expect(recordEvidence(120.5, "Fläche 120,5 m²", page)).toEqual({ status: "passed" });
    expect(recordEvidence("2026-10-18", "Datum 18.10.2026", page)).toEqual({ status: "passed" });
    expect(recordEvidence(42, "Kaufpreis 12.500 EUR", page)).toEqual({
      status: "failed",
      reason: "value_not_parsed"
    });
    expect(recordEvidence(12500, "Invented 12500", page)).toEqual({
      status: "failed",
      reason: "quote_not_found"
    });
    expect(recordEvidence(12500, "Kaufpreis 12.500 EUR", undefined)).toEqual({
      status: "failed",
      reason: "page_not_found"
    });
  });
});
