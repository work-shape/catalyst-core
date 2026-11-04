import type { Browser, BrowserContext } from "playwright";
import {
  HTML_PDF_MAX_PAGES,
  HTML_PDF_MAX_PDF_BYTES,
  type HtmlPdfInput,
  type HtmlPdfOutcome
} from "@work-shape/catalyst-asset-schemas";

// HTML to PDF (PDF-1). The document is served from an address no network has, scripts do not
// run, and every request but that one navigation is aborted before it leaves the browser. The
// content policy says the same a second time: only inline styles and `data:` images, fonts and
// media. Nothing of the document, its size or the PDF is logged.

/** Where the document is served from. `.invalid` never resolves; the route answers it. */
export const PDF_DOCUMENT_URL = "https://document.invalid/";

export const PDF_CONTENT_POLICY = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline' data:",
  "font-src data:",
  "media-src data:",
  "script-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

/** The number of pages of a PDF Chromium wrote: its page objects, never its page tree. */
export function countPdfPages(pdf: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(pdf);
  return text.match(/\/Type\s*\/Page(?![A-Za-z])/gu)?.length ?? 0;
}

/**
 * Prints one document with `browser` in a context of its own, closed afterwards. The caller
 * owns the browser, its sandbox and the deadline: in the service a slot's sandboxed Chromium,
 * in a test the runner's.
 */
export async function renderPdf(
  browser: Browser,
  input: HtmlPdfInput,
  timeoutMs: number
): Promise<HtmlPdfOutcome> {
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      javaScriptEnabled: false,
      acceptDownloads: false,
      serviceWorkers: "block",
      bypassCSP: false
    });
    await context.routeWebSocket("**/*", (socket) => {
      socket.close().catch(() => undefined);
    });
    let served = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        !served &&
        request.method() === "GET" &&
        request.url() === PDF_DOCUMENT_URL &&
        request.isNavigationRequest()
      ) {
        served = true;
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: { "content-security-policy": PDF_CONTENT_POLICY },
          body: input.html
        });
        return;
      }
      await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(PDF_DOCUMENT_URL, { waitUntil: "load", timeout: timeoutMs });
    // Fonts from `data:` addresses finish loading after `load` in some documents.
    await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
    const { format, landscape, margin } = input.options;
    const pdf = await page.pdf({
      format: format ?? "A4",
      // Without a format the document's own `@page` size holds.
      preferCSSPageSize: format === undefined,
      landscape: landscape ?? false,
      printBackground: true,
      tagged: true,
      margin: {
        top: margin?.top ?? "12mm",
        right: margin?.right ?? "12mm",
        bottom: margin?.bottom ?? "12mm",
        left: margin?.left ?? "12mm"
      }
    });
    if (pdf.byteLength > HTML_PDF_MAX_PDF_BYTES)
      return { status: "refused", code: "pdf_too_large" };
    const pages = countPdfPages(pdf);
    if (pages < 1) return { status: "refused", code: "pdf_failed" };
    if (pages > HTML_PDF_MAX_PAGES) return { status: "refused", code: "pdf_too_many_pages" };
    return { status: "done", pdf: new Uint8Array(pdf), pages };
  } catch {
    return { status: "refused", code: "pdf_failed" };
  } finally {
    await context?.close().catch(() => undefined);
  }
}
