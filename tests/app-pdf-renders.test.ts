import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  HtmlPdfInput,
  HtmlPdfOutcome,
  HtmlPdfService,
  RateLimiter
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

// HTML to PDF for an App (PDF-1): a frame hands the instance HTML with its session proof and
// gets the PDF back from the instance's own renderer. The proof is the one every call of a
// frame needs; the document and the PDF are in no audit event. Every test here fails before
// PDF-1: an App had no PDF of its own and sent its report to an outside service.

const REPORT = "<h1>Monthly report 4711</h1>";
const PDF = new TextEncoder().encode("%PDF-1.7 fixture");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A renderer that answers what the test says and keeps what it was asked. */
function renderer(answer: () => HtmlPdfOutcome = () => ({ status: "done", pdf: PDF, pages: 2 })) {
  const asked: HtmlPdfInput[] = [];
  const service: HtmlPdfService = {
    render(input) {
      asked.push(input);
      return Promise.resolve(answer());
    }
  };
  return { service, asked };
}

async function instance(
  options: { htmlPdfService?: HtmlPdfService; rateLimiter?: RateLimiter } = {},
  app = "offers"
) {
  const t = await setupAppInstance({
    ...(options.htmlPdfService ? { htmlPdfService: options.htmlPdfService } : {}),
    ...(options.rateLimiter ? { server: () => ({ rateLimiter: options.rateLimiter }) } : {})
  });
  close = () => t.close();
  expectStatus(await t.putApp(t.admin.id, app, appFiles("Offers", { id: app })), 200);
  return t;
}

const frameSchema = z.looseObject({
  url: z.string(),
  fileSetId: z.string(),
  pageSessionId: z.string()
});

async function frameOf(t: AppInstance, userId: string, app = "offers") {
  const preview = await t.call(userId, "apps.preview", {
    params: { app },
    payload: { mode: "draft" }
  });
  expectStatus(preview, 200);
  const { url, fileSetId, pageSessionId } = frameSchema.parse(preview.json());
  const segments = url.split("/").filter(Boolean);
  const token = segments[segments.indexOf(fileSetId) + 1] ?? "";
  return { pageSessionId, fileSetId, token };
}

function print(
  t: AppInstance,
  userId: string,
  frame: { pageSessionId: string; fileSetId: string; token: string },
  extra: Record<string, unknown> = {}
) {
  return t.call(userId, "apps.sessions.render_pdf", {
    params: { pageSessionId: frame.pageSessionId },
    payload: { fileSetId: frame.fileSetId, token: frame.token, html: REPORT, ...extra }
  });
}

describe("HTML to PDF from an App frame", () => {
  it("answers the PDF of the frame's HTML with its layout, and audits nothing of it", async () => {
    const { service, asked } = renderer();
    const t = await instance({ htmlPdfService: service });
    const frame = await frameOf(t, t.admin.id);

    const printed = await print(t, t.admin.id, frame, {
      options: { format: "A4", landscape: true, margin: { top: "15mm" } }
    });
    expectStatus(printed, 200);
    expect(printed.headers["content-type"]).toBe("application/pdf");
    expect(printed.headers["cache-control"]).toContain("no-store");
    expect(new Uint8Array(printed.rawPayload)).toEqual(PDF);
    expect(asked).toEqual([
      { html: REPORT, options: { format: "A4", landscape: true, margin: { top: "15mm" } } }
    ]);
    // Without options the renderer's defaults hold.
    expectStatus(await print(t, t.admin.id, frame), 200);
    expect(asked[1]).toEqual({ html: REPORT, options: {} });

    const events = await t.stores.audit.listAuditEvents({ clientInstanceId });
    expect(JSON.stringify(events)).not.toContain("Monthly report");
    expect(JSON.stringify(events)).not.toContain("render_pdf");
  });

  it("prints only for the person the frame was given to", async () => {
    const { service, asked } = renderer();
    const t = await instance({ htmlPdfService: service });
    const frame = await frameOf(t, t.admin.id);
    expectStatus(await print(t, t.kai.id, frame), 404);
    expectStatus(await print(t, t.admin.id, { ...frame, token: "x".repeat(32) }), 404);
    expect(asked).toEqual([]);
  });

  it("refuses a layout and an HTML the renderer would not print before it asks", async () => {
    const { service, asked } = renderer();
    const t = await instance({ htmlPdfService: service });
    const frame = await frameOf(t, t.admin.id);
    expectStatus(await print(t, t.admin.id, frame, { options: { format: "B5" } }), 422);
    expectStatus(
      await print(t, t.admin.id, frame, { options: { margin: { top: "calc(1px)" } } }),
      422
    );
    expectStatus(await print(t, t.admin.id, frame, { html: "" }), 422);
    expect(asked).toEqual([]);
  });

  it("names why no PDF was made", async () => {
    const off = await instance();
    const unavailable = await print(off, off.admin.id, await frameOf(off, off.admin.id));
    expectStatus(unavailable, 404);
    expect(unavailable.json()).toMatchObject({ error: { details: { reason: "pdf_unavailable" } } });
    await close?.();

    let code: "pdf_too_many_pages" | "pdf_too_large" | "pdf_busy" | "pdf_failed" =
      "pdf_too_many_pages";
    const t = await instance(
      { htmlPdfService: renderer(() => ({ status: "refused", code })).service },
      "quotes"
    );
    const frame = await frameOf(t, t.admin.id, "quotes");
    for (const [refusal, status] of [
      ["pdf_too_many_pages", 422],
      ["pdf_too_large", 422],
      ["pdf_busy", 429]
    ] as const) {
      code = refusal;
      const refused = await print(t, t.admin.id, frame);
      expectStatus(refused, status);
      expect(refused.json()).toMatchObject({ error: { details: { reason: refusal } } });
    }
    // A failed render is the instance's fault: a timeout, which the frame reads as `timeout`.
    code = "pdf_failed";
    const failed = await print(t, t.admin.id, frame);
    expectStatus(failed, 504);
    expect(failed.json()).toMatchObject({
      error: { code: "TIMEOUT", message: expect.stringContaining("could not be made in time") }
    });
  });

  it("counts the PDFs of one frame against its own limit", async () => {
    const keys: string[] = [];
    let allowed = true;
    const rateLimiter: RateLimiter = {
      consume(key) {
        keys.push(key);
        return Promise.resolve(
          allowed || !key.startsWith("app-pdf:")
            ? { allowed: true, retryAfterMs: 0 }
            : { allowed: false, retryAfterMs: 30_000 }
        );
      }
    };
    const { service, asked } = renderer();
    const t = await instance({ htmlPdfService: service, rateLimiter });
    const frame = await frameOf(t, t.admin.id);
    expectStatus(await print(t, t.admin.id, frame), 200);
    expect(keys).toContain(`app-pdf:${frame.pageSessionId}`);
    allowed = false;
    const limited = await print(t, t.admin.id, frame);
    expectStatus(limited, 429);
    expect(limited.json()).toMatchObject({
      error: { details: { reason: "rate_limited", retryAfterSeconds: 30 } }
    });
    expect(asked).toHaveLength(1);
  });
});
