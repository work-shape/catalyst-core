import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { workbookToUniverSnapshot } from "../packages/chat-ui/src/spreadsheet-preview";

const requireFromChatUi = createRequire(
  new URL("../packages/chat-ui/package.json", import.meta.url)
);
const ExcelJS = requireFromChatUi("exceljs") as typeof import("exceljs");
const {
  BooleanNumber,
  BorderStyleTypes,
  CellValueType,
  HorizontalAlign,
  VerticalAlign,
  WrapStrategy
} = requireFromChatUi("@univerjs/core") as typeof import("@univerjs/core");
const XLSX = requireFromChatUi("xlsx") as typeof import("xlsx");

describe("chat UI spreadsheet preview import", () => {
  it("preserves normal XLSX cell styles and worksheet view settings", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.title = "Styled workbook";
    const dashboard = workbook.addWorksheet("Dashboard", {
      properties: {
        defaultRowHeight: 18,
        tabColor: { argb: "FF6C5CE7" }
      },
      views: [
        {
          state: "frozen",
          xSplit: 1,
          ySplit: 2,
          topLeftCell: "B3",
          showGridLines: false,
          showRowColHeaders: true,
          zoomScale: 125
        }
      ]
    });
    dashboard.mergeCells("B2:D2");
    dashboard.getColumn(2).width = 20;
    dashboard.getRow(2).height = 30;

    const title = dashboard.getCell("B2");
    title.value = "Mission Control";
    title.style = {
      font: {
        name: "Calibri",
        size: 24,
        bold: true,
        italic: true,
        color: { argb: "FFFFFFFF" }
      },
      fill: {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF182449" }
      },
      border: {
        bottom: {
          style: "double",
          color: { argb: "FFD9E2F2" }
        }
      },
      alignment: {
        horizontal: "center",
        vertical: "middle",
        wrapText: true
      }
    };

    const metric = dashboard.getCell("C4");
    metric.value = { formula: "SUM(1,2)", result: 3 };
    metric.numFmt = "$#,##0";

    const hidden = workbook.addWorksheet("Hidden");
    hidden.state = "hidden";

    const bytes = await workbook.xlsx.writeBuffer();
    const snapshot = await workbookToUniverSnapshot(bytes);
    const dashboardSnapshot = snapshot.sheets[snapshot.sheetOrder[0]!]!;
    const titleCell = dashboardSnapshot.cellData?.[1]?.[1];
    const metricCell = dashboardSnapshot.cellData?.[3]?.[2];
    const titleStyle = typeof titleCell?.s === "string" ? snapshot.styles[titleCell.s] : titleCell?.s;
    const metricStyle = typeof metricCell?.s === "string" ? snapshot.styles[metricCell.s] : metricCell?.s;

    expect(snapshot.name).toBe("Styled workbook");
    expect(dashboardSnapshot).toMatchObject({
      tabColor: "#6C5CE7",
      hidden: BooleanNumber.FALSE,
      freeze: {
        xSplit: 1,
        ySplit: 2,
        startRow: 2,
        startColumn: 1
      },
      zoomRatio: 1.25,
      defaultRowHeight: 24,
      showGridlines: BooleanNumber.FALSE
    });
    expect(dashboardSnapshot.mergeData).toContainEqual({
      startRow: 1,
      endRow: 1,
      startColumn: 1,
      endColumn: 3
    });
    expect(dashboardSnapshot.rowData?.[1]).toMatchObject({ h: 40 });
    expect(dashboardSnapshot.columnData?.[1]).toMatchObject({ w: 145 });
    expect(titleCell).toMatchObject({ v: "Mission Control", t: CellValueType.STRING });
    expect(titleStyle).toMatchObject({
      ff: "Calibri",
      fs: 24,
      bl: BooleanNumber.TRUE,
      it: BooleanNumber.TRUE,
      cl: { rgb: "#FFFFFF" },
      bg: { rgb: "#182449" },
      bd: {
        b: {
          s: BorderStyleTypes.DOUBLE,
          cl: { rgb: "#D9E2F2" }
        }
      },
      ht: HorizontalAlign.CENTER,
      vt: VerticalAlign.MIDDLE,
      tb: WrapStrategy.WRAP
    });
    expect(metricCell).toMatchObject({
      v: 3,
      t: CellValueType.NUMBER,
      f: "=SUM(1,2)"
    });
    expect(metricStyle).toMatchObject({ n: { pattern: "$#,##0" } });
    expect(snapshot.sheets[snapshot.sheetOrder[1]!]!.hidden).toBe(BooleanNumber.TRUE);
  });

  it("keeps the existing value preview fallback for legacy XLS files", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Planet", "Revenue"], ["Earth", 1165.95]]),
      "Orders"
    );
    const bytes = XLSX.write(workbook, { bookType: "biff8", type: "array" });

    const snapshot = await workbookToUniverSnapshot(bytes);
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]!]!;

    expect(sheet.name).toBe("Orders");
    expect(sheet.cellData?.[0]?.[0]).toMatchObject({ v: "Planet", t: CellValueType.STRING });
    expect(sheet.cellData?.[1]?.[1]).toMatchObject({ v: 1165.95, t: CellValueType.NUMBER });
  });
});
