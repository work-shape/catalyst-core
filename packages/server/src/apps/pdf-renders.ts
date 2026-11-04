import {
  AppError,
  HTML_PDF_MAX_HTML_BYTES,
  HTML_PDF_MAX_PAGES,
  HTML_PDF_MAX_PDF_BYTES,
  HTML_PDF_RENDERS_PER_MINUTE_PER_SESSION,
  type ActorAccess,
  type AuthenticatedUser,
  type HtmlPdfOptions,
  type HtmlPdfOutcome,
  type HtmlPdfRefusal
} from "@work-shape/catalyst-core";
import type { ResolvedChatServerOptions } from "../types";
import type { AppActionCalls } from "./action-call";

// HTML to PDF for a frame (PDF-1). The frame's address proves which Page or App asks and that
// the caller may see it; the document goes to the instance's own renderer, which reaches no
// network, and the PDF comes back to the frame. No Operation Run, audit event or log line holds
// the document or the PDF: they live in this request only.

const MIB = 1024 * 1024;

const REFUSALS: Record<
  HtmlPdfRefusal,
  { code: ConstructorParameters<typeof AppError>[0]; message: string }
> = {
  pdf_unavailable: {
    code: "NOT_FOUND",
    message:
      "This instance has no PDF renderer switched on, so no PDF can be made. An administrator switches on the preview-capture service."
  },
  pdf_too_large: {
    code: "VALIDATION_FAILED",
    message: `The document is too large: the HTML has at most ${HTML_PDF_MAX_HTML_BYTES / MIB} MiB and the PDF at most ${HTML_PDF_MAX_PDF_BYTES / MIB} MiB (HTML_PDF_MAX_HTML_BYTES, HTML_PDF_MAX_PDF_BYTES). Make the images smaller or split the document.`
  },
  pdf_too_many_pages: {
    code: "VALIDATION_FAILED",
    message: `The PDF would have more than ${HTML_PDF_MAX_PAGES} pages (HTML_PDF_MAX_PAGES). Split the document.`
  },
  pdf_busy: {
    code: "RATE_LIMITED",
    message: "The PDF renderer is busy. Try again in a moment."
  },
  pdf_failed: {
    code: "TIMEOUT",
    message: "The PDF could not be made in time. Try again, or make the document simpler."
  }
};

/** The refusal of one render, worded for the person who looks at the frame. */
function pdfRefusal(code: HtmlPdfRefusal): AppError {
  const { code: errorCode, message } = REFUSALS[code];
  return new AppError(errorCode, message, { reason: code }, { exposeMessage: true });
}

export class AppPdfRenders {
  constructor(
    private readonly options: ResolvedChatServerOptions,
    private readonly actions: AppActionCalls
  ) {}

  /** The PDF of `html`, for a frame the caller is shown. Refuses with a reason otherwise. */
  async render(
    caller: { user: AuthenticatedUser; access: ActorAccess },
    input: {
      pageSessionId: string;
      fileSetId: string;
      token: string;
      html: string;
      options?: HtmlPdfOptions;
    }
  ): Promise<{ pdf: Uint8Array; pages: number }> {
    const { pageSessionId, fileSetId, token } = input;
    // The same proof every call of a frame needs: this caller, this file set, this session.
    await this.actions.session(caller, { pageSessionId, fileSetId, token });
    const service = this.options.pages?.htmlPdfService;
    if (!service) throw pdfRefusal("pdf_unavailable");
    await this.admit(pageSessionId);
    if (Buffer.byteLength(input.html) > HTML_PDF_MAX_HTML_BYTES) throw pdfRefusal("pdf_too_large");
    const outcome: HtmlPdfOutcome = await service.render({
      html: input.html,
      options: input.options ?? {}
    });
    if (outcome.status === "refused") throw pdfRefusal(outcome.code);
    return { pdf: outcome.pdf, pages: outcome.pages };
  }

  private async admit(pageSessionId: string): Promise<void> {
    const { config, rateLimiter } = this.options;
    if (!config.rateLimits.enabled) return;
    const decision = await rateLimiter.consume(`app-pdf:${pageSessionId}`, {
      limit: HTML_PDF_RENDERS_PER_MINUTE_PER_SESSION,
      windowMs: 60_000
    });
    if (!decision.allowed) {
      throw new AppError(
        "RATE_LIMITED",
        `This page asked for more than ${HTML_PDF_RENDERS_PER_MINUTE_PER_SESSION} PDFs in a minute (HTML_PDF_RENDERS_PER_MINUTE_PER_SESSION). Try again later.`,
        {
          reason: "rate_limited",
          retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
        },
        { exposeMessage: true }
      );
    }
  }
}
