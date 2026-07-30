import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { workbookToUniverSnapshot } from "../packages/chat-ui/src/spreadsheet-preview";
import { extractSpreadsheetVisuals } from "../packages/chat-ui/src/spreadsheet-visuals";

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
const JSZip = requireFromChatUi("jszip") as typeof import("jszip");

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

  it("extracts supported charts and images while keeping unsupported charts visible", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dashboard");
    sheet.addRows([["Planet", "Revenue"], ["Earth", 12], ["Mars", 8]]);
    const bytes = await workbook.xlsx.writeBuffer();
    const zip = await JSZip.loadAsync(bytes);
    const worksheetPath = "xl/worksheets/sheet1.xml";
    const worksheetXml = await zip.file(worksheetPath)!.async("string");
    zip.file(
      worksheetPath,
      worksheetXml.replace("</worksheet>", '<drawing r:id="rId99"/></worksheet>')
    );
    zip.file("xl/worksheets/_rels/sheet1.xml.rels", relationshipsXml([
      ["rId99", "drawing", "../drawings/drawing1.xml"]
    ]));
    zip.file("xl/drawings/drawing1.xml", drawingXml());
    zip.file("xl/drawings/_rels/drawing1.xml.rels", relationshipsXml([
      ["rId1", "chart", "../charts/chart1.xml"],
      ["rId2", "chart", "../charts/chart2.xml"],
      ["rId3", "image", "../media/image1.png"]
    ]));
    zip.file("xl/charts/chart1.xml", chartXml("barChart"));
    zip.file("xl/charts/chart2.xml", chartXml("radarChart"));
    zip.file(
      "xl/media/image1.png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      { base64: true }
    );

    const visualBytes = await zip.generateAsync({ type: "arraybuffer" });
    const visuals = await extractSpreadsheetVisuals(visualBytes, workbook);

    expect(visuals).toHaveLength(3);
    expect(visuals[0]).toMatchObject({
      kind: "chart",
      chartType: "column",
      title: "Revenue",
      anchor: { startRow: 4, startColumn: 1, endRow: 9, endColumn: 4 },
      series: [{
        categories: ["Earth", "Mars"],
        values: [12, 8]
      }]
    });
    expect(visuals[1]).toMatchObject({
      kind: "unsupported",
      objectType: "Radar chart"
    });
    expect(visuals[2]).toMatchObject({
      kind: "image",
      name: "Logo"
    });
    expect(visuals[2]?.kind === "image" ? visuals[2].src : "").toMatch(/^data:image\/png;base64,/u);
  });
});

function relationshipsXml(entries: Array<[string, string, string]>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      ${entries.map(([id, type, target]) => `
        <Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>
      `).join("")}
    </Relationships>`;
}

function drawingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      ${chartAnchorXml("rId1", "Column chart", 1)}
      ${chartAnchorXml("rId2", "Radar chart", 6)}
      <xdr:twoCellAnchor>
        ${anchorCellsXml(11)}
        <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="4" name="Logo"/></xdr:nvPicPr>
          <xdr:blipFill><a:blip r:embed="rId3"/></xdr:blipFill>
        </xdr:pic><xdr:clientData/>
      </xdr:twoCellAnchor>
    </xdr:wsDr>`;
}

function chartAnchorXml(relationshipId: string, name: string, column: number): string {
  return `<xdr:twoCellAnchor>
    ${anchorCellsXml(column)}
    <xdr:graphicFrame>
      <xdr:nvGraphicFramePr><xdr:cNvPr id="${column}" name="${name}"/></xdr:nvGraphicFramePr>
      <a:graphic><a:graphicData><c:chart r:id="${relationshipId}"/></a:graphicData></a:graphic>
    </xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>`;
}

function anchorCellsXml(column: number): string {
  return `<xdr:from><xdr:col>${column}</xdr:col><xdr:row>4</xdr:row></xdr:from>
    <xdr:to><xdr:col>${column + 3}</xdr:col><xdr:colOff>1</xdr:colOff>
      <xdr:row>9</xdr:row><xdr:rowOff>1</xdr:rowOff></xdr:to>`;
}

function chartXml(type: "barChart" | "radarChart"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <c:chart>
        <c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>
        <c:plotArea><c:${type}><c:barDir val="col"/><c:ser>
          <c:tx><c:v>Revenue</c:v></c:tx>
          <c:cat><c:strRef><c:f>Dashboard!$A$2:$A$3</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Dashboard!$B$2:$B$3</c:f></c:numRef></c:val>
        </c:ser></c:${type}></c:plotArea>
      </c:chart>
    </c:chartSpace>`;
}
