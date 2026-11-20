import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_DOWNLOAD_DEFAULT_CONTENT_TYPES } from "@work-shape/catalyst-core";
import {
  contentDispositionFilename,
  DirectWebDownloader,
  mediaTypeAllowed,
  WEB_DOWNLOAD_TOOL_NAME,
  WebFetchFailure,
  type WebDownloadRuntimeConfig,
  type WebFetchAddressResolver,
  type WebFetchHttpRequest,
  type WebFetchHttpRequestInput
} from "@work-shape/catalyst-web-access";
import { jsonObject } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestExecution } from "./support/test-instance";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// web_download: an agent brings one file from a public address into its conversation's
// execution workspace, on web_fetch's checked path, and reads it there with the workspace
// tools. Off unless the instance switches on web access, its download and execution workspaces.

const PDF = Buffer.from("%PDF-1.7 synthetic fixture");

const resolvePublic: WebFetchAddressResolver = () =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

const config: WebDownloadRuntimeConfig = {
  timeoutMs: 5000,
  maxBytes: 1024,
  maxRedirects: 2,
  contentTypes: [...WEB_DOWNLOAD_DEFAULT_CONTENT_TYPES]
};

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/** A server that answers each address by its path; records what was asked and what was read. */
function server(answers: Record<string, Answer>) {
  const asked: WebFetchHttpRequestInput[] = [];
  const bodiesRead: string[] = [];
  const request: WebFetchHttpRequest = (input) => {
    asked.push(input);
    const answer = answers[input.url.pathname] ?? { status: 404 };
    const status = answer.status ?? 200;
    const headers = answer.headers ?? {};
    const body = answer.body ?? new Uint8Array();
    const reads = input.readsBody ? input.readsBody(status, headers) : true;
    if (!reads || (status >= 300 && status < 400)) {
      return Promise.resolve({
        status,
        headers,
        body: new Uint8Array(),
        bytesRead: 0,
        truncatedByBytes: false
      });
    }
    bodiesRead.push(input.url.pathname);
    const stored = body.subarray(0, input.maxBytes);
    return Promise.resolve({
      status,
      headers,
      body: stored,
      bytesRead: stored.byteLength,
      truncatedByBytes: body.byteLength > input.maxBytes
    });
  };
  return { request, asked, bodiesRead };
}

function downloader(
  answers: Record<string, Answer>,
  overrides: Partial<WebDownloadRuntimeConfig> = {}
) {
  const fake = server(answers);
  return {
    ...fake,
    downloader: new DirectWebDownloader({
      config: { ...config, ...overrides },
      resolver: resolvePublic,
      request: fake.request
    })
  };
}

async function failureOf(promise: Promise<unknown>): Promise<WebFetchFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WebFetchFailure) return error;
    throw error;
  }
  throw new Error("Expected a WebFetchFailure");
}

describe("web download: the fetch path", () => {
  it("reads a whole allowed file and names it from Content-Disposition", async () => {
    const { downloader: fetcher, asked } = downloader({
      "/files/42": {
        headers: {
          "content-type": "application/pdf",
          "content-length": String(PDF.byteLength),
          "content-disposition": "attachment; filename*=UTF-8''Quarterly%20report.pdf"
        },
        body: PDF
      }
    });
    const file = await fetcher.download({ url: "https://files.example.com/files/42?sig=abc" });
    expect(file).toMatchObject({
      finalUrl: "https://files.example.com/files/42?sig=abc",
      mediaType: "application/pdf",
      filename: "Quarterly report.pdf",
      redirectCount: 0
    });
    expect(Buffer.from(file.bytes)).toEqual(PDF);
    expect(asked[0]?.accept).toBe("*/*");
  });

  it("blocks a private address before any request, also behind a redirect", async () => {
    const { downloader: fetcher, asked } = downloader({});
    const direct = await failureOf(fetcher.download({ url: "http://127.0.0.1/secret.pdf" }));
    expect(direct.metadata).toMatchObject({ reason: "blocked_url" });
    expect(asked).toEqual([]);

    const redirecting = downloader({
      "/start": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }
    });
    const behind = await failureOf(
      redirecting.downloader.download({ url: "https://files.example.com/start" })
    );
    expect(behind.metadata).toMatchObject({ reason: "blocked_url", redirectCount: 1 });
    expect(redirecting.asked.map((input) => input.url.hostname)).toEqual(["files.example.com"]);
  });

  it("refuses a media type the instance does not allow without reading the body", async () => {
    const { downloader: fetcher, bodiesRead } = downloader(
      { "/app.exe": { headers: { "content-type": "application/x-msdownload" }, body: PDF } },
      { contentTypes: ["application/pdf"] }
    );
    const failure = await failureOf(fetcher.download({ url: "https://files.example.com/app.exe" }));
    expect(failure.code).toBe("validation_failed");
    expect(failure.metadata).toMatchObject({ reason: "unsupported_content_type" });
    expect(bodiesRead).toEqual([]);
  });

  it("refuses a file above the limit instead of cutting it, unread when its size is declared", async () => {
    const big = new Uint8Array(2048);
    const declared = downloader({
      "/big.pdf": {
        headers: { "content-type": "application/pdf", "content-length": "2048" },
        body: big
      }
    });
    const refused = await failureOf(
      declared.downloader.download({ url: "https://files.example.com/big.pdf" })
    );
    expect(refused.message).toContain("larger than the limit of 1024 bytes");
    expect(refused.metadata).toMatchObject({ reason: "too_large", maxBytes: 1024 });
    expect(declared.bodiesRead).toEqual([]);

    const undeclared = downloader({
      "/big.pdf": { headers: { "content-type": "application/pdf" }, body: big }
    });
    const cut = await failureOf(
      undeclared.downloader.download({ url: "https://files.example.com/big.pdf" })
    );
    expect(cut.metadata).toMatchObject({ reason: "too_large" });
  });

  it("refuses a compressed encoding and an HTTP error", async () => {
    const { downloader: fetcher } = downloader({
      "/gz": { headers: { "content-type": "text/csv", "content-encoding": "gzip" }, body: PDF },
      "/gone": { status: 410, headers: { "content-type": "text/html" } }
    });
    expect(
      (await failureOf(fetcher.download({ url: "https://files.example.com/gz" }))).metadata
    ).toMatchObject({ reason: "unsupported_content_encoding" });
    const gone = await failureOf(fetcher.download({ url: "https://files.example.com/gone" }));
    expect(gone.message).toBe("web_download received HTTP 410");
  });

  it("matches media types exactly, by family and by */*", () => {
    expect(mediaTypeAllowed(["image/*"], "image/png")).toBe(true);
    expect(mediaTypeAllowed(["image/*"], "imagex/png")).toBe(false);
    expect(mediaTypeAllowed(["application/pdf"], "Application/PDF")).toBe(true);
    expect(mediaTypeAllowed(["application/pdf"], "application/pdfx")).toBe(false);
    expect(mediaTypeAllowed(["*/*"], "application/x-anything")).toBe(true);
    expect(mediaTypeAllowed(["*/*"], "nonsense")).toBe(false);
  });

  it("takes only the last segment of a Content-Disposition name", () => {
    expect(contentDispositionFilename('attachment; filename="../../etc/passwd"')).toBe("passwd");
    expect(contentDispositionFilename("attachment; filename=plain.csv")).toBe("plain.csv");
    expect(contentDispositionFilename("inline")).toBeUndefined();
  });
});

describe("web_download in the workspace", () => {
  it("writes the file under inputs/ and audits host, type and size only", async () => {
    const { downloader: webDownload } = downloader({
      "/exports/7/data": {
        headers: { "content-type": "text/csv; charset=utf-8" },
        body: Buffer.from("name,value\nalpha,1\n")
      }
    });
    const harness = await createWorkspaceHarness({ webDownload });

    const result = await harness.runTool(WEB_DOWNLOAD_TOOL_NAME, {
      url: "https://data.example.com/exports/7/data?token=s3cret"
    });
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    const output = jsonObject(result.output);
    expect(output).toMatchObject({
      path: "inputs/data.csv",
      mediaType: "text/csv",
      byteSize: 19
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
    const stored = files.find((file) => file.path === "inputs/data.csv");
    expect(stored).toMatchObject({ mimeType: "text/csv", byteSize: 19 });
    expect(Buffer.from(harness.objectStore.bytes(stored?.objectKey ?? ""))).toEqual(
      Buffer.from("name,value\nalpha,1\n")
    );

    expect(result.auditSummary).toEqual({
      action: "web_download",
      subject: "data.example.com",
      metadata: {
        status: "success",
        host: "data.example.com",
        contentType: "text/csv",
        byteSize: 19,
        redirectCount: 0
      }
    });
    const audited = JSON.stringify(result.auditSummary);
    for (const secret of ["s3cret", "exports", "data.csv", "alpha"]) {
      expect(audited).not.toContain(secret);
    }

    // The agent reads the downloaded file with the workspace tools.
    const read = await harness.runTool("workspace.read_file", { path: "inputs/data.csv" });
    expect(JSON.stringify(read)).toContain("alpha,1");
  });

  it("writes to the path the agent names, checked before anything is fetched", async () => {
    const { downloader: webDownload, asked } = downloader({
      "/r.pdf": { headers: { "content-type": "application/pdf" }, body: PDF }
    });
    const harness = await createWorkspaceHarness({ webDownload });
    const named = await harness.runTool(WEB_DOWNLOAD_TOOL_NAME, {
      url: "https://files.example.com/r.pdf",
      path: "reports/q3.pdf"
    });
    if (named.status !== "success") throw new Error(JSON.stringify(named));
    expect(jsonObject(named.output)).toMatchObject({ path: "reports/q3.pdf" });

    const escaping = await harness.runTool(WEB_DOWNLOAD_TOOL_NAME, {
      url: "https://files.example.com/r.pdf",
      path: "../outside.pdf"
    });
    expect(escaping.status).toBe("failed");
    expect(asked).toHaveLength(1);
  });

  it("keeps the failure audit to host and reason", async () => {
    const { downloader: webDownload } = downloader(
      {
        "/private/report.xlsx": {
          headers: { "content-type": "application/x-msdownload; name=report.exe" },
          body: PDF
        }
      },
      { contentTypes: ["application/pdf"] }
    );
    const harness = await createWorkspaceHarness({ webDownload });
    const result = await harness.runTool(WEB_DOWNLOAD_TOOL_NAME, {
      url: "https://files.example.com/private/report.xlsx?key=k123"
    });
    if (result.status !== "failed") throw new Error("Expected a refusal");
    expect(result.auditSummary).toEqual({
      action: "web_download",
      subject: "files.example.com",
      metadata: {
        status: "failed",
        reason: "unsupported_content_type",
        httpStatus: 200,
        bytes: 0,
        redirectCount: 0,
        contentType: "application/x-msdownload",
        host: "files.example.com"
      }
    });
    const audited = JSON.stringify(result.auditSummary);
    for (const secret of ["k123", "private", "report"]) {
      expect(audited).not.toContain(secret);
    }

    // An address with credentials is refused before any request, and they stay out of the audit.
    const withCredentials = await harness.runTool(WEB_DOWNLOAD_TOOL_NAME, {
      url: "https://user:pa55word@files.example.com/private/report.xlsx"
    });
    if (withCredentials.status !== "failed") throw new Error("Expected a refusal");
    expect(withCredentials.auditSummary?.metadata).toMatchObject({ reason: "blocked_url" });
    expect(JSON.stringify(withCredentials.auditSummary)).not.toMatch(/pa55word|user|private/u);
  });

  it("refuses a file that would overfill the workspace and writes nothing", async () => {
    const { downloader: webDownload } = downloader({
      "/r.pdf": { headers: { "content-type": "application/pdf" }, body: PDF }
    });
    const harness = await createWorkspaceHarness({
      webDownload,
      limits: { maxWorkspaceBytes: 8 }
    });
    const result = await harness.runTool(WEB_DOWNLOAD_TOOL_NAME, {
      url: "https://files.example.com/r.pdf"
    });
    if (result.status !== "failed") throw new Error("Expected a refusal");
    expect(result.error.message).toContain("maxWorkspaceBytes");
  });

  it("is offered only with a downloader", async () => {
    const without = await createWorkspaceHarness();
    expect(without.tools.map((tool) => tool.name)).not.toContain(WEB_DOWNLOAD_TOOL_NAME);
  });
});

describe("web_download's switch", () => {
  it("is off by default, with bounded defaults", () => {
    const parsed = createTestConfig();
    expect(parsed.webAccess.download).toEqual({
      enabled: false,
      timeoutMs: 60_000,
      maxBytes: 25 * 1024 * 1024,
      maxRedirects: 5,
      contentTypes: [...WEB_DOWNLOAD_DEFAULT_CONTENT_TYPES]
    });
    // The default list is copied, not shared between configs.
    expect(createTestConfig().webAccess.download.contentTypes).not.toBe(
      parsed.webAccess.download.contentTypes
    );
  });

  it("refuses a size above 100 MiB and a media type that is no pattern", () => {
    expect(() =>
      createTestConfig({ webAccess: { download: { maxBytes: 101 * 1024 * 1024 } } })
    ).toThrow(/webAccess\.download\.maxBytes/u);
    expect(() => createTestConfig({ webAccess: { download: { contentTypes: ["pdf"] } } })).toThrow(
      /type\/subtype/u
    );
    expect(
      createTestConfig({ webAccess: { download: { contentTypes: [" Image/* "] } } }).webAccess
        .download.contentTypes
    ).toEqual(["image/*"]);
  });

  it.each([
    ["web access off", { enabled: false, download: { enabled: true } }, true],
    ["download off", { enabled: true, download: { enabled: false } }, true],
    ["workspaces off", { enabled: true, download: { enabled: true } }, false]
  ])("registers no web_download with %s", async (_case, webAccess, workspaces) => {
    const registered = await registeredTools({ webAccess, workspaces });
    expect(registered).not.toContain(WEB_DOWNLOAD_TOOL_NAME);
  });

  it("registers web_download when web access, its download and workspaces are on", async () => {
    const registered = await registeredTools({
      webAccess: { enabled: true, download: { enabled: true } },
      workspaces: true
    });
    expect(registered).toContain(WEB_DOWNLOAD_TOOL_NAME);
    expect(registered).not.toContain("web_fetch");
  });
});

async function registeredTools(input: {
  webAccess: Record<string, unknown>;
  workspaces: boolean;
}): Promise<string[]> {
  const workspaceObjectRoot = await mkdtemp(join(tmpdir(), "catalyst-web-download-"));
  const testConfig = createTestConfig({
    executionWorkspaces: { enabled: input.workspaces },
    workspaceObjectRoot,
    webAccess: input.webAccess
  });
  testConfig.infrastructure.objectStorage.files = {
    provider: "filesystem",
    root: join(workspaceObjectRoot, "files")
  };
  const assembly = await createTestInstance({
    execution: { config: testConfig, tools: [], env: {} }
  }).then(getTestExecution);
  try {
    return assembly.localAgentRuntimeOptions.toolRegistry.listDefined().map((tool) => tool.name);
  } finally {
    await assembly.close();
    await rm(workspaceObjectRoot, { recursive: true, force: true });
  }
}
