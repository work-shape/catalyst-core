import { z } from "zod";
import {
  HTML_PDF_MAX_HTML_BYTES,
  HTML_PDF_MAX_PAGES,
  HTML_PDF_MAX_PDF_BYTES,
  htmlPdfOptionsSchema,
  readObjectBytes,
  type HtmlPdfRefusal,
  type HtmlPdfService,
  type ToolExecutionContext,
  type ToolHandlerResult
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { failed, normalizeWorkspaceFilePath } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import {
  checkPathFitsWorkspace,
  checkWorkspaceRoom,
  resolveTextFilePath,
  storeTextFile
} from "./stored-text-file";
import { findWorkspaceFile } from "./workspace";

// HTML to PDF for an agent (PDF-1): an HTML file of the workspace goes to the instance's own
// renderer, which reaches no network, and the PDF comes back as a workspace file only. The agent
// checks its pages and hands the final file over once with workspace.promote_artifact, so a
// draft never becomes a download card. The trace names the path, the pages and the size.

export const HTML_TO_PDF_TOOL_NAME = "workspace.html_to_pdf";

const MIB = 1024 * 1024;

const htmlToPdfInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .describe("The HTML file in /workspace to print, such as report/index.html."),
    output: z
      .string()
      .min(1)
      .max(1024)
      .describe("Where the PDF is written in /workspace. Omit it for the HTML's path with .pdf.")
      .optional()
  })
  .extend(htmlPdfOptionsSchema.shape)
  .strict();

const htmlToPdfOutputSchema = z.object({
  path: z.string(),
  pages: z.number().int(),
  byteSize: z.number().int()
});

const REASONS: Record<HtmlPdfRefusal, string> = {
  pdf_unavailable:
    "This instance runs no PDF renderer, so no PDF was made. Tell the person an administrator switches on the preview-capture service; do not send the document to an outside service.",
  pdf_too_large: `The HTML has more than ${HTML_PDF_MAX_HTML_BYTES / MIB} MiB or the PDF would have more than ${HTML_PDF_MAX_PDF_BYTES / MIB} MiB. Make embedded images smaller, or split the document.`,
  pdf_too_many_pages: `The PDF would have more than ${HTML_PDF_MAX_PAGES} pages. Split the document into several files.`,
  pdf_busy: "The PDF renderer is busy. Call again in a moment.",
  pdf_failed:
    "The renderer could not print the document in time. Make it simpler, such as fewer or smaller images, and call again."
};

export function workspaceHtmlToPdfTool(
  deps: WorkspaceToolDependencies & { htmlPdf: HtmlPdfService }
) {
  return defineTool({
    name: HTML_TO_PDF_TOOL_NAME,
    title: { en: "Make a PDF from HTML", de: "PDF aus HTML erstellen" },
    summary: {
      en: "Prints an HTML file of the conversation to a PDF in its files.",
      de: "Druckt eine HTML-Datei der Unterhaltung als PDF in ihre Dateien."
    },
    group: "files",
    icon: "file",
    effect: "changing",
    // Runs on the agent's own call, like workspace.write_file and workspace.promote_artifact.
    permission: { mode: "allow" },
    description: [
      "Print an HTML file of /workspace to a PDF in the instance's own renderer and write it to /workspace. Make every new PDF this way, as HTML and CSS: never an outside PDF service. It makes no download card: render the pages to PNG under /workspace/previews (pdf_render_pages, or pdftoppm), look at every page with workspace.preview_images, fix the HTML and print again, then hand the final PDF over once with workspace.promote_artifact.",
      "The renderer has no network: every style, image and font must be in the file itself or a data: address; a link to anything else stays empty. Scripts do not run, so draw charts as inline SVG and put the finished content in the HTML. Page breaks and page numbers follow print CSS (break-before, @page margin boxes with counter(page)).",
      `Without format the file's own @page size holds, otherwise A4; margins default to 12mm. At most ${HTML_PDF_MAX_HTML_BYTES / MIB} MiB of HTML, ${HTML_PDF_MAX_PAGES} pages and ${HTML_PDF_MAX_PDF_BYTES / MIB} MiB of PDF.`,
      `Use the pdf_* helpers to fill forms, merge, split or edit an existing PDF and to check one; use reportlab only to draw on an existing PDF, for a document over ${HTML_PDF_MAX_PAGES} pages, or where this tool is not offered.`
    ].join(" "),
    inputSchema: htmlToPdfInputSchema,
    outputSchema: htmlToPdfOutputSchema,
    execute(input, context) {
      return htmlToPdf(deps, input, context);
    }
  });
}

async function htmlToPdf(
  deps: WorkspaceToolDependencies & { htmlPdf: HtmlPdfService },
  input: z.infer<typeof htmlToPdfInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof htmlToPdfOutputSchema>>> {
  const { fileStore, objectStore } = deps;
  if (!fileStore || !objectStore) {
    return failed(
      "handler_failed",
      `This instance has no storage for workspace files, so ${HTML_TO_PDF_TOOL_NAME} cannot run. Tell the person this is a problem of the platform, not of their input.`
    );
  }
  const source = normalizeWorkspaceFilePath(input.path, deps.limits);
  if (source.status === "failed") return source.result;
  const target = resolveTextFilePath(
    input.output ?? source.value.replace(/\.html?$/iu, "") + ".pdf",
    deps.limits
  );
  if (target.status === "failed") return target.result;
  if (target.value === source.value) {
    return failed("validation_failed", "The output must be another path than the HTML file.", {
      path: source.value
    });
  }
  const found = await findWorkspaceFile(deps, context, source.value);
  if (found.status === "failed") return found.result;
  const html = found.value.file;
  if (html.byteSize > HTML_PDF_MAX_HTML_BYTES) return refused("pdf_too_large");
  const bytes = await readObjectBytes(objectStore, html.objectKey);
  const outcome = await deps.htmlPdf.render({
    html: new TextDecoder().decode(bytes),
    options: {
      ...(input.format ? { format: input.format } : {}),
      ...(input.landscape === undefined ? {} : { landscape: input.landscape }),
      ...(input.margin ? { margin: input.margin } : {})
    }
  });
  if (outcome.status === "refused") return refused(outcome.code);

  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: found.value.handle.id
  });
  const fits = checkPathFitsWorkspace(files, target.value);
  if (fits.status === "failed") return fits.result;
  const room = checkWorkspaceRoom(deps, files, target.value, outcome.pdf.byteLength);
  if (room.status === "failed") return room.result;
  const workspace = await deps.workspaces.resolveWorkspaceHandle(context);
  if (!workspace) return failed("handler_failed", "Workspace tools require an active tool request");
  const stored = await storeTextFile({ ...deps, fileStore }, context, {
    toolName: HTML_TO_PDF_TOOL_NAME,
    workspace,
    path: target.value,
    bytes: outcome.pdf,
    existing: files.find((file) => file.path === target.value),
    mimeType: "application/pdf"
  });
  return toolSuccess(
    { path: stored.path, pages: outcome.pages, byteSize: stored.byteSize },
    {
      // The path, the pages and the size. Never the document or the PDF.
      auditSummary: {
        action: HTML_TO_PDF_TOOL_NAME,
        subject: stored.path,
        metadata: { path: stored.path, pages: outcome.pages, byteSize: stored.byteSize }
      }
    }
  );
}

function refused(code: HtmlPdfRefusal): ToolHandlerResult<never> {
  return failed("handler_failed", REASONS[code], { code });
}
