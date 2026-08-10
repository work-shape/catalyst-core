import { describe, expect, it } from "vitest";
import {
  formatSpreadsheetRangeSelector,
  parseSpreadsheetRangeSelector,
  resolveSpreadsheetSheetName,
  spreadsheetSelectorKey
} from "../packages/tool-execution/src/spreadsheet-preview-selectors";

describe("spreadsheet preview selectors", () => {
  it("round-trips quoted sheet names containing apostrophes and separators", () => {
    const parsed = parseSpreadsheetRangeSelector("'Bob''s ! Sheet'! A1:B4");

    expect(parsed).toEqual({
      sheetName: "Bob's ! Sheet",
      rangeText: "A1:B4"
    });
    expect(formatSpreadsheetRangeSelector(parsed.sheetName!, parsed.rangeText)).toBe(
      "'Bob''s ! Sheet'!A1:B4"
    );
  });

  it("keeps unqualified ranges separate from sheet-selection policy", () => {
    expect(parseSpreadsheetRangeSelector(" A1:B4 ")).toEqual({ rangeText: "A1:B4" });
    expect(formatSpreadsheetRangeSelector("Summary", "A1:B4")).toBe("Summary!A1:B4");
  });

  it("matches selectors case-insensitively while preserving workbook spelling", () => {
    expect(spreadsheetSelectorKey(" Summary!A1:B4 ")).toBe("summary!a1:b4");
    expect(resolveSpreadsheetSheetName(["Summary", "Detail"], "summary")).toBe("Summary");
  });

  it("preserves first-match ambiguity and reports missing sheets", () => {
    expect(resolveSpreadsheetSheetName(["Summary", "SUMMARY"], "summary")).toBe("Summary");
    expect(resolveSpreadsheetSheetName(["Summary"], "Missing")).toBeUndefined();
    expect(resolveSpreadsheetSheetName([], undefined)).toBeUndefined();
  });
});
