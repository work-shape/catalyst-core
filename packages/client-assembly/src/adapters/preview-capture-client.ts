import {
  AppError,
  HTML_PDF_MAX_HTML_BYTES,
  HTML_PDF_MAX_PDF_BYTES,
  HTML_PDF_OPTIONS_HEADER,
  HTML_PDF_PAGES_HEADER,
  HTML_PDF_REFUSALS,
  HTML_PDF_RENDER_MS,
  serverPreviewCaptureOutcomeSchema,
  type HtmlPdfOutcome,
  type HtmlPdfService,
  type SecretResolver,
  type PreviewCaptureService
} from "@work-shape/catalyst-core";
import type { ClientInstanceEnv } from "../env";
/** Only the API gets this client. Off unless explicitly enabled; the tool stays on PREVIEW-SEE-1. */
export async function createInstancePreviewCaptureClient(
  env: ClientInstanceEnv,
  secrets: SecretResolver
): Promise<PreviewCaptureService | undefined> {
  const service = await captureServiceOf(env, secrets);
  if (!service) return undefined;
  const { url, token } = service;
  return {
    async capture(input) {
      try {
        const response = await fetch(new URL("/capture", url), {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, input.deadline - Date.now())))
        });
        if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 600_000)
          throw new Error("Capture failed");
        const body = await response.text();
        if (body.length > 600_000) throw new Error("Capture failed");
        return serverPreviewCaptureOutcomeSchema.parse(JSON.parse(body));
      } catch {
        return { status: "refused", code: "capture_failed" };
      }
    }
  };
}

/** Where the isolated renderer answers and its token, or nothing while it is off. */
async function captureServiceOf(
  env: ClientInstanceEnv,
  secrets: SecretResolver
): Promise<{ url: URL; token: string } | undefined> {
  if (env.PREVIEW_CAPTURE_ENABLED !== "true") return undefined;
  const token = await secrets.resolve("PREVIEW_CAPTURE_SERVICE_TOKEN");
  const url = new URL(env.PREVIEW_CAPTURE_SERVICE_ORIGIN ?? "http://preview-capture:4120");
  if (
    !token ||
    token.length < 32 ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new AppError(
      "VALIDATION_FAILED",
      "PREVIEW_CAPTURE_SERVICE_TOKEN (at least 32 characters) and a service origin are required when PREVIEW_CAPTURE_ENABLED is true"
    );
  return { url, token };
}

const PDF_FAILED: HtmlPdfOutcome = { status: "refused", code: "pdf_failed" };

/**
 * HTML to PDF (PDF-1) through the same isolated renderer, for the API, which serves it to Apps.
 * Off with the renderer. The document goes as the body and comes back as PDF bytes; neither is
 * logged, and a failure is a refusal that names no payload.
 */
export async function createInstanceHtmlPdfClient(
  env: ClientInstanceEnv,
  secrets: SecretResolver
): Promise<HtmlPdfService | undefined> {
  const service = await captureServiceOf(env, secrets);
  if (!service) return undefined;
  const { url, token } = service;
  return {
    async render(input) {
      const body = new TextEncoder().encode(input.html);
      if (body.byteLength > HTML_PDF_MAX_HTML_BYTES)
        return { status: "refused", code: "pdf_too_large" };
      try {
        const response = await fetch(new URL("/pdf", url), {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "text/html; charset=utf-8",
            [HTML_PDF_OPTIONS_HEADER]: JSON.stringify(input.options)
          },
          body,
          // The renderer's own deadline, its queue and the upload of the document.
          signal: AbortSignal.timeout(HTML_PDF_RENDER_MS + 15_000)
        });
        if (response.status === 422) {
          const answer: unknown = await response.json().catch(() => undefined);
          const code =
            typeof answer === "object" && answer !== null && "code" in answer
              ? HTML_PDF_REFUSALS.find((refusal) => refusal === answer.code)
              : undefined;
          return code ? { status: "refused", code } : PDF_FAILED;
        }
        const pages = Number(response.headers.get(HTML_PDF_PAGES_HEADER));
        if (
          !response.ok ||
          response.headers.get("content-type") !== "application/pdf" ||
          !Number.isInteger(pages) ||
          pages < 1
        ) {
          await response.body?.cancel();
          return PDF_FAILED;
        }
        const parts: Uint8Array[] = [];
        let length = 0;
        if (response.body)
          for await (const part of response.body) {
            length += part.byteLength;
            if (length > HTML_PDF_MAX_PDF_BYTES)
              return { status: "refused", code: "pdf_too_large" };
            parts.push(part);
          }
        return { status: "done", pdf: new Uint8Array(Buffer.concat(parts)), pages };
      } catch {
        return PDF_FAILED;
      }
    }
  };
}
