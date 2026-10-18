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
  it.each([
    [1205, "Wohnfläche 120,5 m²", "de", "failed"],
    [15, "1,5 Zimmer", "de", "failed"],
    [350, "350.000 EUR", "de", "failed"],
    [35, "35O.OOO", "de", "failed"],
    ["5", "15 Einheiten", "de", "failed"],
    [120.5, "Wohnfläche 120,5 m²", "de", "passed"],
    [350000, "350.000 EUR", "de", "passed"],
    [350, "350,000 EUR", "en", "failed"],
    [350000, "350,000 EUR", "en", "passed"],
    [120.5, "Area 120.5 m²", "de", "passed"],
    [120.5, "Area 120,5 m²", "en", "passed"],
    [1205, "Area 12.05 m²", "de", "failed"],
    ["2026-01-02", "Datum 2.1.2026", "de", "passed"],
    ["2024-03-01", "Datum 1. März 2024", "de", "passed"],
    ["2024-03-01", "March 1, 2024", "en", "passed"],
    ["2024-03-01", "1. März 24", "de", "failed"],
    ["2024-03-01", "March 1, 24", "en", "failed"],
    ["2024-03-01", "1.3.24", "de", "failed"],
    ["größer", "größer", "de", "passed"]
  ] as const)("parses %s from %s under %s: %s", (value, quote, locale, status) => {
    expect(recordEvidence(value, quote, quote, locale).status).toBe(status);
  });
  it.each(["NordSüd", "Nord-Süd"])("accepts a line-end hyphen as joined or kept: %s", (value) => {
    expect(recordEvidence(value, value, "Nord-\nSüd").status).toBe("passed");
    expect(recordEvidence(value, "Nord-\nSüd", value).status).toBe("passed");
  });
  it("never accepts a quoted digit cut out of a larger number on the page", () => {
    expect(recordEvidence("5", "5", "15 Einheiten").status).toBe("failed");
  });
  it("normalises Unicode, whitespace, soft hyphens and words hyphenated at line ends on both sides", () => {
    expect(
      recordEvidence("Gebäudefläche", "Gebäudefläche 120,5 m²", "Gebäude-\nfläche  120,5\n m²")
    ).toEqual({ status: "passed" });
    expect(
      recordEvidence("Gebäudefläche", "Gebäude\u00adfläche   120,5 m²", "Gebäudefläche 120,5 m²")
    ).toEqual({ status: "passed" });
  });
});
