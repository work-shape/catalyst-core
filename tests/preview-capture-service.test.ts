import { DEFAULT_THEME_INPUTS } from "@work-shape/catalyst-ui/theme";
import { describe, expect, it } from "vitest";
import {
  captureEnvironment,
  captureInputSchema,
  forwardedPath
} from "@work-shape/catalyst-preview-capture";
import {
  createInstanceHtmlPdfClient,
  createInstancePreviewCaptureClient
} from "@work-shape/catalyst-client-assembly";
import { createEnvironmentSecretResolver } from "@work-shape/catalyst-core";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parse } from "yaml";

const token = "fixture-service-token-".repeat(3);
const origin = "https://interface.example";
const prefix = "/app-content/fset_00000000-0000-0000-0000-000000000000/proof.mac/";
describe("server capture boundaries", () => {
  it("starts dark and refuses a client with no service credential", async () => {
    const secrets = createEnvironmentSecretResolver({
      env: {},
      readSecretFile: async () => {
        throw new Error("No secret file");
      }
    });
    expect(await createInstancePreviewCaptureClient({}, secrets)).toBeUndefined();
    await expect(
      createInstancePreviewCaptureClient({ PREVIEW_CAPTURE_ENABLED: "true" }, secrets)
    ).rejects.toThrow();
  });
  it.each([
    "DATABASE_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "OBJECT_STORAGE_KEY",
    "OPENAI_API_KEY",
    "BETTER_AUTH_SECRET",
    "CHAT_SESSION_TOKEN_SECRET",
    "APP_CONTENT_KEY"
  ])("refuses %s in the service environment", async (key) => {
    await expect(
      captureEnvironment({ PREVIEW_CAPTURE_SERVICE_TOKEN: token, [key]: "forbidden" })
    ).rejects.toThrow();
  });
  it("accepts only a fixed-origin GET of the capture's files or versioned kit", () => {
    expect(forwardedPath("GET", origin + prefix + "main.js", origin, prefix)).toBe(
      prefix + "main.js"
    );
    expect(
      forwardedPath("GET", origin + "/app-runtime/kit/1.0.0/fonts/inter/font.woff2", origin, prefix)
    ).toContain("font.woff2");
    for (const path of [
      "/unexpected/users",
      "/app-content/another/token/",
      prefix + "../private",
      prefix + "%2fprivate",
      "/app-runtime/kit/../private",
      "/app-runtime/kit/1.0.0/../../../unexpected",
      prefix + "?token=other"
    ])
      expect(forwardedPath("GET", origin + path, origin, prefix)).toBeUndefined();
    expect(forwardedPath("POST", origin + prefix, origin, prefix)).toBeUndefined();
    expect(
      forwardedPath("GET", "https://outside.example/pixel?secret=yes", origin, prefix)
    ).toBeUndefined();
    expect(forwardedPath("GET", "http://api:4100" + prefix, origin, prefix)).toBeUndefined();
  });
  it("accepts no person, run, grant or arbitrary URL in a service request", () => {
    const input = {
      themeColors: DEFAULT_THEME_INPUTS.light,
      contentPath: prefix,
      session: "capture:pcap_fixture",
      deadline: Date.now() + 1000,
      size: "desktop",
      theme: "light",
      locale: "en",
      number: 1
    };
    expect(captureInputSchema.safeParse(input).success).toBe(true);
    for (const field of ["person", "run", "grant", "url"])
      expect(captureInputSchema.safeParse({ ...input, [field]: "other" }).success).toBe(false);
  });
  it("ships only an isolated, credential-minimal opt-in Compose service", () => {
    const compose = parse(
      readFileSync("packages/deployment-kit/docker/preview-capture.compose.yml", "utf8")
    );
    const service = compose.services["preview-capture"];
    expect(service.profiles).toEqual(["preview-capture"]);
    expect(service.networks).toEqual(["preview-capture"]);
    expect(compose.networks["preview-capture"].internal).toBe(true);
    // Only the API reaches the renderer: it captures and prints PDFs for Apps (PDF-1).
    expect(Object.keys(compose.services)).toEqual(["api", "preview-capture"]);
    expect(Object.keys(compose.services.api.networks)).toEqual(["default", "preview-capture"]);
    expect(Object.keys(compose.services.api.environment).sort()).toEqual([
      "PREVIEW_CAPTURE_ENABLED",
      "PREVIEW_CAPTURE_SERVICE_ORIGIN",
      "PREVIEW_CAPTURE_SERVICE_TOKEN"
    ]);
    expect(Object.keys(service.environment).sort()).toEqual([
      "PREVIEW_CAPTURE_API_ORIGIN",
      "PREVIEW_CAPTURE_CONCURRENCY",
      "PREVIEW_CAPTURE_INTERFACE_ORIGIN",
      "PREVIEW_CAPTURE_SERVICE_TOKEN"
    ]);
    expect(service).toMatchObject({
      user: "10001:10001",
      read_only: true,
      cap_drop: ["ALL"],
      shm_size: "512m",
      pids_limit: 384,
      cpus: 1.5
    });
    expect(service.security_opt[0]).toBe("no-new-privileges:true");
    expect(service.volumes).toBeUndefined();
    expect(service.env_file).toBeUndefined();
  });
});

// HTML to PDF (PDF-1): the API's client of the renderer for Apps. The renderer itself is
// proven in the Linux container suite; here a fake service answers as the renderer would.
describe("HTML to PDF client", () => {
  const pdfBytes = new TextEncoder().encode("%PDF-1.7 fixture");
  async function withService(
    answer: (request: IncomingMessage, body: Buffer, response: ServerResponse) => void,
    run: (
      client: NonNullable<Awaited<ReturnType<typeof createInstanceHtmlPdfClient>>>
    ) => Promise<void>
  ) {
    const server = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => answer(request, Buffer.concat(parts), response));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const { port } = address;
    const secrets = createEnvironmentSecretResolver({
      env: { PREVIEW_CAPTURE_SERVICE_TOKEN: token },
      readSecretFile: async () => {
        throw new Error("No secret file");
      }
    });
    try {
      const client = await createInstanceHtmlPdfClient(
        {
          PREVIEW_CAPTURE_ENABLED: "true",
          PREVIEW_CAPTURE_SERVICE_ORIGIN: `http://127.0.0.1:${port}`
        },
        secrets
      );
      if (!client) throw new Error("No client");
      await run(client);
    } finally {
      await new Promise((done) => server.close(done));
    }
  }

  it("is off while the renderer is off", async () => {
    const secrets = createEnvironmentSecretResolver({
      env: {},
      readSecretFile: async () => {
        throw new Error("No secret file");
      }
    });
    expect(await createInstanceHtmlPdfClient({}, secrets)).toBeUndefined();
    await expect(
      createInstanceHtmlPdfClient({ PREVIEW_CAPTURE_ENABLED: "true" }, secrets)
    ).rejects.toThrow();
  });

  it("sends the HTML as the body with the token and the layout, and answers the PDF", async () => {
    const seen: Record<string, unknown> = {};
    await withService(
      (request, body, response) => {
        Object.assign(seen, {
          auth: request.headers.authorization,
          type: request.headers["content-type"],
          options: request.headers["x-pdf-options"],
          body: body.toString("utf8"),
          path: request.url
        });
        response.writeHead(200, { "content-type": "application/pdf", "x-pdf-pages": "3" });
        response.end(pdfBytes);
      },
      async (client) => {
        const outcome = await client.render({
          html: "<h1>Prüfbericht</h1>",
          options: { format: "A4", margin: { top: "15mm" } }
        });
        expect(outcome).toEqual({ status: "done", pdf: pdfBytes, pages: 3 });
      }
    );
    expect(seen).toMatchObject({
      auth: `Bearer ${token}`,
      type: "text/html; charset=utf-8",
      options: JSON.stringify({ format: "A4", margin: { top: "15mm" } }),
      body: "<h1>Prüfbericht</h1>",
      path: "/pdf"
    });
  });

  it("passes the renderer's refusal on and turns every other answer into a failure", async () => {
    const answers: Array<(response: ServerResponse) => void> = [
      (response) => {
        response.writeHead(422, { "content-type": "application/json" });
        response.end('{"code":"pdf_too_many_pages"}');
      },
      (response) => {
        response.writeHead(422, { "content-type": "application/json" });
        response.end('{"code":"something_else"}');
      },
      (response) => {
        response.writeHead(200, { "content-type": "text/html", "x-pdf-pages": "1" });
        response.end("<p>not a PDF</p>");
      },
      (response) => {
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(pdfBytes);
      },
      (response) => {
        response.writeHead(500);
        response.end();
      },
      (response) => {
        response.writeHead(200, { "content-type": "application/pdf", "x-pdf-pages": "1" });
        response.end(Buffer.alloc(10 * 1024 * 1024 + 1));
      }
    ];
    let next = 0;
    await withService(
      (_request, _body, response) => answers[next++]?.(response),
      async (client) => {
        const codes = [];
        for (const _ of answers) {
          const outcome = await client.render({ html: "<p>x</p>", options: {} });
          codes.push(outcome.status === "refused" ? outcome.code : outcome.status);
        }
        expect(codes).toEqual([
          "pdf_too_many_pages",
          "pdf_failed",
          "pdf_failed",
          "pdf_failed",
          "pdf_failed",
          "pdf_too_large"
        ]);
      }
    );
  });

  it("refuses an HTML beyond its bound before it sends it", async () => {
    let asked = 0;
    await withService(
      (_request, _body, response) => {
        asked++;
        response.end();
      },
      async (client) => {
        expect(await client.render({ html: "ä".repeat(2 * 1024 * 1024 + 1), options: {} })).toEqual(
          { status: "refused", code: "pdf_too_large" }
        );
      }
    );
    expect(asked).toBe(0);
  });
});
