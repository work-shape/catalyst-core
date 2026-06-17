import { AppError, type AppErrorCode } from "@vivd-catalyst/core";
import type { DocumentPageViewer, ViewDocumentPageInput, ViewDocumentPageResult } from "./page-render-service";

export interface RemoteDocumentPageViewerOptions {
  baseUrl: string;
  timeoutMs: number;
  token?: string;
}

export class RemoteDocumentPageViewer implements DocumentPageViewer {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token?: string;

  constructor(options: RemoteDocumentPageViewerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.timeoutMs = options.timeoutMs;
    this.token = options.token;
  }

  async viewPage(input: ViewDocumentPageInput): Promise<ViewDocumentPageResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/internal/document-pages/render`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify(input),
        signal: controller.signal
      });
      const body = (await response.json().catch(() => undefined)) as
        | ViewDocumentPageResult
        | { code?: string; message?: string }
        | undefined;
      if (!response.ok) {
        const errorBody = isErrorBody(body) ? body : undefined;
        throw new AppError(
          toAppErrorCode(errorBody?.code),
          errorBody?.message ?? "Document worker page rendering failed"
        );
      }
      return body as ViewDocumentPageResult;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        "INTERNAL",
        error instanceof Error ? error.message : "Document worker page rendering failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isErrorBody(value: unknown): value is { code?: string; message?: string } {
  return value !== null && typeof value === "object" && ("code" in value || "message" in value);
}

function toAppErrorCode(code: string | undefined): AppErrorCode {
  if (
    code === "BAD_REQUEST" ||
    code === "UNAUTHENTICATED" ||
    code === "FORBIDDEN" ||
    code === "NOT_FOUND" ||
    code === "CONFLICT" ||
    code === "TIMEOUT" ||
    code === "VALIDATION_FAILED" ||
    code === "INTERNAL"
  ) {
    return code;
  }
  return "INTERNAL";
}
