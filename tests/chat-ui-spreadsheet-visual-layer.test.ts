import { describe, expect, it } from "vitest";
import { spreadsheetChartOption } from "../packages/chat-ui/src/spreadsheet-visual-layer";
import type { SpreadsheetVisual } from "../packages/chat-ui/src/spreadsheet-visuals";

const chart: Extract<SpreadsheetVisual, { kind: "chart" }> = {
  id: "chart-1",
  kind: "chart",
  sheetName: "Dashboard",
  name: "Share",
  anchor: { startRow: 0, startColumn: 0, endRow: 10, endColumn: 4 },
  chartType: "pie",
  title: "Share by region",
  series: []
};

describe("chat UI spreadsheet visual layer", () => {
  it("renders a pie chart without series as a titled empty chart", () => {
    for (const chartType of ["pie", "doughnut"] as const) {
      const option = spreadsheetChartOption({ ...chart, chartType });
      expect(option).toMatchObject({ title: { text: "Share by region" } });
      expect(option).not.toHaveProperty("series");
      expect(option).not.toHaveProperty("legend");
    }
  });

  it("renders the first series of a pie chart as named slices", () => {
    const option = spreadsheetChartOption({
      ...chart,
      series: [{ name: "Share", categories: ["North", ""], values: [3, 1] }]
    });
    expect(option).toMatchObject({
      series: [
        {
          type: "pie",
          data: [
            { name: "North", value: 3 },
            { name: "Item 2", value: 1 }
          ]
        }
      ]
    });
  });
});
