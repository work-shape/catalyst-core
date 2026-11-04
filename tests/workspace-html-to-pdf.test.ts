import { describe, expect, it } from "vitest";
import type { HtmlPdfInput, HtmlPdfOutcome, HtmlPdfService } from "@work-shape/catalyst-core";
import { HTML_TO_PDF_TOOL_NAME } from "@work-shape/catalyst-tool-execution";
import { jsonObject } from "./support/assertions";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// HTML to PDF for an agent (PDF-1): the agent prints an HTML file of its workspace in the
// instance's own renderer, checks the pages and hands the final PDF over once with
// workspace.promote_artifact. Before PDF-1 an agent had no tool for a PDF and reached for an
// outside service or a library.

const REPORT = "<h1>Monthly report 4711</h1>";
const PDF = new TextEncoder().encode("%PDF-1.7 fixture");

function renderer(answer: () => HtmlPdfOutcome = () => ({ status: "done", pdf: PDF, pages: 3 })) {
  const asked: HtmlPdfInput[] = [];
  const service: HtmlPdfService = {
    render(input) {
      asked.push(input);
      return Promise.resolve(answer());
    }
  };
  return { service, asked };
}

async function withReport(htmlPdf?: HtmlPdfService) {
  const harness = await createWorkspaceHarness(htmlPdf ? { htmlPdf } : {});
  await harness.putWorkspaceFile({
    path: "report/index.html",
    objectKey: "workspace/report/index.html",
    bytes: REPORT,
    mimeType: "text/html"
  });
  return harness;
}

describe("workspace.html_to_pdf", () => {
  it("prints a workspace HTML file to a PDF in the workspace", async () => {
    const { service, asked } = renderer();
    const harness = await withReport(service);

    const result = await harness.runTool(HTML_TO_PDF_TOOL_NAME, {
      path: "report/index.html",
      format: "A4",
      landscape: true,
      margin: { top: "15mm" }
    });
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    expect(asked).toEqual([
      { html: REPORT, options: { format: "A4", landscape: true, margin: { top: "15mm" } } }
    ]);
    expect(jsonObject(result.output)).toEqual({
      path: "report/index.pdf",
      pages: 3,
      byteSize: PDF.byteLength
    });
    // The trace names the path, the pages and the size, never the document or the PDF.
    expect(JSON.stringify(result.auditSummary)).not.toContain("Monthly report 4711");
    expect(result.auditSummary?.metadata).toEqual({
      path: "report/index.pdf",
      pages: 3,
      byteSize: PDF.byteLength
    });

    const workspace = await harness.store.executionWorkspaces.getExecutionWorkspaceForConversation({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id
    });
    if (!workspace) throw new Error("No workspace");
    const files = await harness.store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: workspace.id
    });
    const stored = files.find((file) => file.path === "report/index.pdf");
    expect(stored).toMatchObject({ mimeType: "application/pdf", byteSize: PDF.byteLength });
    expect(harness.objectStore.bytes(stored?.objectKey ?? "")).toEqual(PDF);
  });

  it("makes no download card, so only the promoted final PDF reaches the person", async () => {
    const harness = await withReport(renderer().service);

    const draft = await harness.runTool(HTML_TO_PDF_TOOL_NAME, {
      path: "report/index.html",
      output: "out/report.pdf"
    });
    if (draft.status !== "success") throw new Error(JSON.stringify(draft));
    expect(draft.artifacts ?? []).toEqual([]);
    expect(jsonObject(draft.output)).not.toHaveProperty("artifactId");
    const again = await harness.runTool(HTML_TO_PDF_TOOL_NAME, {
      path: "report/index.html",
      output: "out/report.pdf"
    });
    if (again.status !== "success") throw new Error(JSON.stringify(again));
    expect(again.artifacts ?? []).toEqual([]);

    const promoted = await harness.runTool("workspace.promote_artifact", {
      path: "out/report.pdf",
      kind: "document.pdf",
      filename: "Monthly report.pdf"
    });
    if (promoted.status !== "success") throw new Error(JSON.stringify(promoted));
    expect(promoted.artifacts).toEqual([
      expect.objectContaining({ filename: "Monthly report.pdf", mimeType: "application/pdf" })
    ]);
  });

  it("refuses the download name, which belongs to workspace.promote_artifact", async () => {
    const { service, asked } = renderer();
    const harness = await withReport(service);
    const result = await harness.runTool(HTML_TO_PDF_TOOL_NAME, {
      path: "report/index.html",
      filename: "Monthly report.pdf"
    });
    expect(result.status).toBe("failed");
    expect(asked).toEqual([]);
  });

  it("is offered only where the instance runs a renderer", async () => {
    const without = await createWorkspaceHarness();
    expect(without.tools.map((tool) => tool.name)).not.toContain(HTML_TO_PDF_TOOL_NAME);
    const withRenderer = await createWorkspaceHarness({ htmlPdf: renderer().service });
    expect(withRenderer.tools.map((tool) => tool.name)).toContain(HTML_TO_PDF_TOOL_NAME);
  });

  it("names the renderer's refusal and writes nothing", async () => {
    const harness = await withReport(
      renderer(() => ({ status: "refused", code: "pdf_too_many_pages" })).service
    );
    const result = await harness.runTool(HTML_TO_PDF_TOOL_NAME, {
      path: "report/index.html",
      output: "out/report.pdf"
    });
    if (result.status !== "failed") throw new Error("Expected a refusal");
    expect(result.error.message).toContain("more than 50 pages");
    expect(result.error.details).toMatchObject({ code: "pdf_too_many_pages" });
    const workspace = await harness.store.executionWorkspaces.getExecutionWorkspaceForConversation({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id
    });
    const files = workspace
      ? await harness.store.executionWorkspaces.listWorkspaceFiles({
          clientInstanceId: harness.clientInstanceId,
          workspaceId: workspace.id
        })
      : [];
    expect(files.map((file) => file.path)).toEqual(["report/index.html"]);
  });

  it("refuses a file that is not there and an output on the HTML itself before it prints", async () => {
    const { service, asked } = renderer();
    const harness = await withReport(service);
    const missing = await harness.runTool(HTML_TO_PDF_TOOL_NAME, { path: "report/missing.html" });
    expect(missing.status).toBe("failed");
    const onItself = await harness.runTool(HTML_TO_PDF_TOOL_NAME, {
      path: "report/index.html",
      output: "report/index.html"
    });
    expect(onItself.status).toBe("failed");
    const badLayout = await harness.runTool(HTML_TO_PDF_TOOL_NAME, {
      path: "report/index.html",
      format: "B5"
    });
    expect(badLayout.status).toBe("failed");
    expect(asked).toEqual([]);
  });
});
