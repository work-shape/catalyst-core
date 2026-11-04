import type { HtmlPdfInput, HtmlPdfOutcome } from "@work-shape/catalyst-asset-schemas";

export {
  HTML_PDF_MAX_HTML_BYTES,
  HTML_PDF_MAX_PAGES,
  HTML_PDF_MAX_PDF_BYTES,
  HTML_PDF_OPTIONS_HEADER,
  HTML_PDF_PAGES_HEADER,
  HTML_PDF_PAGE_FORMATS,
  HTML_PDF_REFUSALS,
  HTML_PDF_RENDER_MS,
  HTML_PDF_RENDERS_PER_MINUTE_PER_SESSION,
  htmlPdfOptionsSchema
} from "@work-shape/catalyst-asset-schemas";
export type {
  HtmlPdfInput,
  HtmlPdfOptions,
  HtmlPdfOutcome,
  HtmlPdfRefusal
} from "@work-shape/catalyst-asset-schemas";

/**
 * The instance's renderer of HTML to PDF (PDF-1): the isolated preview-capture service. It
 * holds no credential and reaches no network; a caller hands it everything the document shows.
 * A refusal is an outcome, never an exception, and names no payload.
 */
export interface HtmlPdfService {
  render(input: HtmlPdfInput): Promise<HtmlPdfOutcome>;
}
