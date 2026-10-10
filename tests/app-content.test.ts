import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_CONTENT_TOKEN_TTL_SECONDS,
  deriveAppContentKey,
  storePageFileSet
} from "@vivd-catalyst/chat-server";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  asClientInstanceId,
  asConversationId,
  pageFileObjectKey,
  type Logger
} from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { callTestPath, createTestInstance, createTestInstanceWith } from "./support/test-instance";

// A Page revision is served to the frame that shows it and to nobody else. The address a member
// is given holds a token for one file set; every answer under it carries the same header set,
// and that header set is what keeps the Page in its frame.

const text = (value: string) => new TextEncoder().encode(value);
/** Where the filesystem store of an assembled test instance would keep its files. */
const filesRoot = join(tmpdir(), "catalyst-app-content-test-files");

const INDEX_HTML = `<!doctype html><html><head><link rel="stylesheet" href="./assets/style.css"></head><body><h1 title="a &amp; b">Offer "A"</h1><script type="module" src="./assets/main.js"></script></body></html>`;
const MAIN_JS = `document.body.dataset.ready = "true";\n`;
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>parent.postMessage("x","*")</script></svg>`;

const builtFiles = [
  { path: "index.html", bytes: text(INDEX_HTML) },
  { path: "assets/main.js", bytes: text(MAIN_JS) },
  { path: "assets/style.css", bytes: text("h1 { color: rgb(1, 2, 3); }") },
  { path: "assets/icon.svg", bytes: text(ICON_SVG) }
];
const sourceFiles = [
  { path: "index.html", bytes: text(INDEX_HTML) },
  { path: "src/main.ts", bytes: text("document.body.dataset.ready = 'true';\n") }
];

interface ErrorBody {
  error: { code: string; message: string; details?: { reason?: string; module?: string } };
}
interface Preview {
  url: string;
  expiresAt: string;
  fileSetId: string;
  number: number;
  pageSessionId: string;
}

const HEADER_SET = {
  "content-security-policy":
    "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; frame-ancestors 'self' https://ui.example.test",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-dns-prefetch-control": "off",
  "access-control-allow-origin": "*",
  "cross-origin-resource-policy": "cross-origin"
};

/** Every line the server wrote, as text. A request object is reduced to its address. */
function collectingLogger() {
  const lines: string[] = [];
  const write = (input: unknown, message?: string) => {
    const request =
      typeof input === "object" && input !== null ? Reflect.get(input, "req") : undefined;
    const address =
      typeof request === "object" && request !== null ? Reflect.get(request, "url") : undefined;
    lines.push(
      `${message ?? ""} ${typeof address === "string" ? address : ""} ${
        input instanceof Error ? `${input.message} ${input.stack ?? ""}` : safeJson(input)
      }`
    );
  };
  const logger: Logger = {
    debug: write,
    info: write,
    warn: write,
    error: write,
    child: () => logger
  };
  return { logger, lines };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

async function startInstance(appsEnabled = true) {
  const config = parseClientInstanceConfig({
    ...createTestConfig(),
    modules: { apps: { enabled: appsEnabled } }
  });
  const objects = new MemoryObjectStorage();
  const pages = { objects, contentKey: deriveAppContentKey("content-secret-".repeat(4)) };
  const { logger, lines } = collectingLogger();
  const instance = await createTestInstanceWith(() => ({
    config,
    modules: resolveInstanceModules(config).snapshot,
    pages,
    logger,
    allowedOrigins: ["https://ui.example.test"]
  }));
  const context = {
    clientInstanceId: asClientInstanceId(config.clientInstance.id),
    stores: instance.stores,
    pages
  };
  return { instance, objects, context, lines };
}

type Started = Awaited<ReturnType<typeof startInstance>>;

/** A conversation of `user-1` with one Page of one revision. */
async function withPage({ instance, context }: Started, pageName = "Offer") {
  const created = await instance.call(
    "conversations.create",
    { payload: { title: "Pages" } },
    "user-1"
  );
  const conversationId = asConversationId(created.json<{ id: string }>().id);
  const stored = await storePageFileSet(context, {
    conversationId,
    pageName,
    kitVersion: "1.0.0",
    manifest: { entry: "index.html" },
    sourceFiles,
    builtFiles
  });
  return { conversationId, ...stored };
}

async function preview(
  instance: Started["instance"],
  page: { conversationId: string; page: { id: string } },
  as = "user-1",
  fileSetId?: string
) {
  return instance.call(
    "pages.preview",
    {
      params: { conversationId: page.conversationId, pageId: page.page.id },
      payload: fileSetId ? { fileSetId } : {}
    },
    as
  );
}

const asFrame = { "sec-fetch-dest": "iframe" };
const asScript = { "sec-fetch-dest": "script" };

afterEach(() => {
  vi.useRealTimers();
});

describe("the content route of a Page", () => {
  it("serves the files of the file set its token was made for, each with the header set", async () => {
    const started = await startInstance();
    const { instance } = started;
    const page = await withPage(started);
    const { url, fileSetId, number } = (await preview(instance, page)).json<Preview>();
    expect({ fileSetId, number }).toEqual({ fileSetId: page.fileSet.id, number: 1 });
    expect(url.startsWith(`/app-content/${page.fileSet.id}/`)).toBe(true);
    expect(url.endsWith("/")).toBe(true);

    const script = await callTestPath(instance, "GET", `${url}assets/main.js`, asScript);
    expect(script.statusCode).toBe(200);
    expect(script.body).toBe(MAIN_JS);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.headers).toMatchObject(HEADER_SET);
    // Kept by the browser for as long as the address is valid, and by no shared cache.
    expect(script.headers["cache-control"]).toMatch(/^private, max-age=\d+, immutable$/u);

    const style = await callTestPath(instance, "GET", `${url}assets/style.css`, {
      "sec-fetch-dest": "style"
    });
    expect(style.statusCode).toBe(200);
    expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(style.headers).toMatchObject(HEADER_SET);

    // The platform's own script of the frame, below every file set.
    const guard = await callTestPath(instance, "GET", `${url}__catalyst/guard-1.js`, asScript);
    expect(guard.statusCode).toBe(200);
    expect(guard.body).toContain("RTCPeerConnection");
    expect(guard.headers).toMatchObject(HEADER_SET);
  });

  it("answers an HTML file as the shell that holds it in a sandboxed frame, never as stored", async () => {
    const started = await startInstance();
    const { instance } = started;
    const { url } = (await preview(instance, await withPage(started))).json<Preview>();

    for (const address of [url, `${url}index.html`]) {
      const shell = await callTestPath(instance, "GET", address, asFrame);
      expect(shell.statusCode).toBe(200);
      expect(shell.headers).toMatchObject(HEADER_SET);
      expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");
      // The frame the server writes allows scripts and nothing else.
      const frame = /<iframe sandbox="([^"]*)" title="Page" srcdoc="([^"]*)"><\/iframe>/u.exec(
        shell.body
      );
      expect(frame?.[1]).toBe("allow-scripts");
      // The stored HTML is the value of an attribute and of nothing else in the shell.
      expect(shell.body.split("<iframe").length).toBe(2);
      expect(shell.body).not.toContain(INDEX_HTML);
      const held = (frame?.[2] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
      // The guard is in the document before the first byte of the Page.
      expect(held).toBe(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><script src="__catalyst/guard-1.js"></script></head>\n${INDEX_HTML}`
      );
    }
  });

  it("answers a token on another file set, an expired token and an altered token with 404", async () => {
    const started = await startInstance();
    const { instance } = started;
    const first = await withPage(started, "First");
    const second = await withPage(started, "Second");
    const { url, expiresAt } = (await preview(instance, first)).json<Preview>();
    const token = url.split("/")[3] ?? "";
    expect(token.length).toBeGreaterThan(60);

    const refusalOf = async (address: string) => {
      const response = await callTestPath(instance, "GET", address, asScript);
      // A refusal carries the header set too, and no browser keeps it.
      expect(response.headers).toMatchObject({ ...HEADER_SET, "cache-control": "no-store" });
      return {
        status: response.statusCode,
        reason: response.json<ErrorBody>().error.details?.reason
      };
    };
    const invalid = { status: 404, reason: "token_invalid" };

    // The same token in the address of another file set, which exists and has the same files.
    expect(await refusalOf(`/app-content/${second.fileSet.id}/${token}/assets/main.js`)).toEqual(
      invalid
    );
    // One character altered, at every position of the token in turn.
    for (let index = 0; index < token.length; index += 1) {
      const replacement = token[index] === "A" ? "B" : "A";
      const altered = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
      expect(
        await refusalOf(`/app-content/${first.fileSet.id}/${altered}/assets/main.js`),
        `character ${index}`
      ).toEqual(invalid);
    }
    // One character more or less, and no token at all.
    expect(await refusalOf(`/app-content/${first.fileSet.id}/${token}A/assets/main.js`)).toEqual(
      invalid
    );
    expect(
      await refusalOf(`/app-content/${first.fileSet.id}/${token.slice(0, -1)}/assets/main.js`)
    ).toEqual(invalid);
    expect(await refusalOf(`/app-content/${first.fileSet.id}/assets/main.js`)).toEqual(invalid);
    expect(await refusalOf(`/app-content/${first.fileSet.id}/${token}`)).toEqual(invalid);

    // The untouched token still serves, until its time is over.
    expect((await callTestPath(instance, "GET", `${url}assets/main.js`, asScript)).statusCode).toBe(
      200
    );
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(
      APP_CONTENT_TOKEN_TTL_SECONDS * 1000
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(expiresAt) - 1000);
    expect((await callTestPath(instance, "GET", `${url}assets/main.js`, asScript)).statusCode).toBe(
      200
    );
    vi.setSystemTime(Date.parse(expiresAt));
    expect(await refusalOf(`${url}assets/main.js`)).toEqual({
      status: 404,
      reason: "token_expired"
    });
  });

  it("answers a file the file set does not hold with file_unknown, source files included", async () => {
    const started = await startInstance();
    const { instance } = started;
    const { url } = (await preview(instance, await withPage(started))).json<Preview>();

    for (const path of ["assets/none.js", "src/main.ts", "../index.html", "__catalyst/other.js"]) {
      const response = await callTestPath(instance, "GET", `${url}${path}`, asScript);
      expect(response.statusCode, path).toBe(404);
      expect(response.headers).toMatchObject(HEADER_SET);
    }
    const unknown = await callTestPath(instance, "GET", `${url}assets/none.js`, asScript);
    expect(unknown.json<ErrorBody>().error.details).toEqual({ reason: "file_unknown" });
  });

  it("hands an HTML file to a frame only and no other file to a navigation", async () => {
    const started = await startInstance();
    const { instance } = started;
    const { url } = (await preview(instance, await withPage(started))).json<Preview>();
    const statusOf = async (path: string, destination: string) =>
      (await callTestPath(instance, "GET", `${url}${path}`, { "sec-fetch-dest": destination }))
        .statusCode;

    // Opened in a tab, the shell would be a page an agent wrote under the instance's address.
    expect(await statusOf("", "document")).toBe(403);
    expect(await statusOf("index.html", "script")).toBe(403);
    expect(await statusOf("", "iframe")).toBe(200);
    // An SVG file opened as a document runs its script. As an image it does not.
    for (const destination of ["document", "iframe", "frame", "object", "embed"]) {
      expect(await statusOf("assets/icon.svg", destination), destination).toBe(403);
      expect(await statusOf("assets/main.js", destination), destination).toBe(403);
    }
    expect(await statusOf("assets/icon.svg", "image")).toBe(200);
    const refused = await callTestPath(instance, "GET", `${url}assets/icon.svg`, {
      "sec-fetch-dest": "document"
    });
    expect(refused.headers).toMatchObject({ ...HEADER_SET, "cache-control": "no-store" });
  });

  it("does not hand out a stored file that is not the one its file set names", async () => {
    const started = await startInstance();
    const { instance, objects } = started;
    const page = await withPage(started);
    const { url } = (await preview(instance, page)).json<Preview>();
    await objects.put(
      pageFileObjectKey(page.page.id, page.fileSet.id, "dist", "assets/main.js"),
      text(`fetch("https://other.example.test/");\n`)
    );

    const response = await callTestPath(instance, "GET", `${url}assets/main.js`, asScript);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("other.example.test");
    expect(response.headers).toMatchObject(HEADER_SET);
  });

  it("writes the token to no log line", async () => {
    const started = await startInstance();
    const { instance, lines } = started;
    const page = await withPage(started);
    const { url } = (await preview(instance, page)).json<Preview>();
    const token = url.split("/")[3] ?? "";
    const [payload = "", signature = ""] = token.split(".");

    await callTestPath(instance, "GET", url, asFrame);
    await callTestPath(instance, "GET", `${url}assets/main.js`, asScript);
    await callTestPath(instance, "GET", `${url}assets/none.js`, asScript);
    await callTestPath(instance, "GET", `${url.slice(0, -2)}A/assets/main.js`, asScript);
    await callTestPath(instance, "GET", url, { "sec-fetch-dest": "document" });

    // Other requests are logged with their address, so the absence below says something.
    expect(lines.some((line) => line.includes("/health"))).toBe(true);
    expect(lines.filter((line) => line.includes("/app-content/"))).toEqual([]);
    expect(lines.filter((line) => line.includes(payload) || line.includes(signature))).toEqual([]);
  });
});

describe("pages.preview", () => {
  it("refuses a user who is not a member of the conversation and mints nothing", async () => {
    const started = await startInstance();
    const { instance } = started;
    const page = await withPage(started);

    const refused = await preview(instance, page, "user-2");
    // A conversation someone may not read does not exist for them, as on every other route.
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain("/app-content/");
    const listed = await instance.call(
      "pages.list",
      { params: { conversationId: page.conversationId } },
      "user-2"
    );
    expect(listed.statusCode).toBe(404);
    const detail = await instance.call(
      "pages.get",
      { params: { conversationId: page.conversationId, pageId: page.page.id } },
      "user-2"
    );
    expect(detail.statusCode).toBe(404);
    const file = await instance.call(
      "pages.files.get",
      {
        params: {
          conversationId: page.conversationId,
          pageId: page.page.id,
          fileSetId: page.fileSet.id
        },
        query: { path: "src/main.ts" }
      },
      "user-2"
    );
    expect(file.statusCode).toBe(404);

    const allowed = await preview(instance, page, "user-1");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["cache-control"]).toBe("no-store");
  });

  it("names the newest revision unless another is asked for, and no revision of another Page", async () => {
    const started = await startInstance();
    const { instance, context } = started;
    const page = await withPage(started);
    const second = await storePageFileSet(context, {
      conversationId: page.conversationId,
      pageName: "Offer",
      kitVersion: "1.0.0",
      manifest: {},
      sourceFiles,
      builtFiles: [{ path: "index.html", bytes: text("<h1>Second</h1>") }]
    });
    const other = await withPage(started, "Other");

    expect((await preview(instance, page)).json<Preview>()).toMatchObject({
      fileSetId: second.fileSet.id,
      number: 2
    });
    const older = (await preview(instance, page, "user-1", page.fileSet.id)).json<Preview>();
    expect(older).toMatchObject({ fileSetId: page.fileSet.id, number: 1 });
    // The first revision is served as it was stored, after the second was stored.
    const script = await callTestPath(instance, "GET", `${older.url}assets/main.js`, asScript);
    expect(script.body).toBe(MAIN_JS);

    // A file set of another Page is not a revision of this one, also for its own member.
    const foreign = await preview(instance, page, "user-1", other.fileSet.id);
    expect(foreign.statusCode).toBe(404);
  });

  it("lists the Pages of a conversation, their revisions and a source file", async () => {
    const started = await startInstance();
    const { instance } = started;
    const page = await withPage(started);
    const params = { conversationId: page.conversationId, pageId: page.page.id };

    const listed = await instance.call(
      "pages.list",
      { params: { conversationId: page.conversationId } },
      "user-1"
    );
    expect(listed.json<{ items: { id: string; name: string }[] }>().items).toMatchObject([
      { id: page.page.id, name: "Offer" }
    ]);
    const detail = await instance.call("pages.get", { params }, "user-1");
    expect(detail.json<{ fileSets: object[] }>().fileSets).toMatchObject([
      { id: page.fileSet.id, number: 1, sourceFileCount: 2, builtFileCount: 4 }
    ]);
    const file = await instance.call(
      "pages.files.get",
      { params: { ...params, fileSetId: page.fileSet.id }, query: { path: "src/main.ts" } },
      "user-1"
    );
    expect(file.json<{ text: string; contentType: string }>()).toMatchObject({
      path: "src/main.ts",
      text: "document.body.dataset.ready = 'true';\n"
    });
  });
});

describe("a deleted conversation", () => {
  it("leaves no row and no object of its Pages, and a token that is still valid serves nothing", async () => {
    const started = await startInstance();
    const { instance, objects, context } = started;
    const page = await withPage(started);
    const kept = await withPage(started, "Kept elsewhere");
    const { url } = (await preview(instance, page)).json<Preview>();
    expect((await callTestPath(instance, "GET", url, asFrame)).statusCode).toBe(200);
    const objectsOf = async (pageId: string) =>
      (await objects.list(`pages/${pageId}/`)).objects.length;
    expect(await objectsOf(page.page.id)).toBe(sourceFiles.length + builtFiles.length);

    const deleted = await instance.call(
      "conversations.delete",
      { params: { conversationId: page.conversationId } },
      "user-1"
    );
    expect(deleted.statusCode).toBeLessThan(300);

    for (const address of [url, `${url}assets/main.js`]) {
      const response = await callTestPath(instance, "GET", address, asFrame);
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.details).toEqual({ reason: "file_set_unknown" });
      expect(response.headers).toMatchObject(HEADER_SET);
    }
    expect(await objectsOf(page.page.id)).toBe(0);
    expect(
      await context.stores.pages.listConversationPageIds({
        clientInstanceId: context.clientInstanceId,
        conversationId: page.conversationId
      })
    ).toEqual([]);
    expect(
      await context.stores.pages.getPageFileSet({
        clientInstanceId: context.clientInstanceId,
        pageId: page.page.id,
        fileSetId: page.fileSet.id
      })
    ).toBeUndefined();
    // The Page of another conversation is untouched.
    expect(await objectsOf(kept.page.id)).toBe(sourceFiles.length + builtFiles.length);
  });
});

describe("with the apps module off", () => {
  it("answers the content route and every pages operation with 404 module_off", async () => {
    const on = await startInstance();
    const page = await withPage(on);
    const { url } = (await preview(on.instance, page)).json<Preview>();
    await on.instance.close();

    // The same database and the same key, with the switch off.
    const off = await startInstance(false);
    const moduleOff = { reason: "module_off", module: "apps" };
    const content = await callTestPath(off.instance, "GET", `${url}assets/main.js`, asScript);
    expect(content.statusCode).toBe(404);
    expect(content.json<ErrorBody>().error.details).toEqual(moduleOff);

    const params = {
      conversationId: page.conversationId,
      pageId: page.page.id,
      fileSetId: page.fileSet.id
    };
    const answers = [
      await off.instance.call("pages.list", { params: { conversationId: params.conversationId } }),
      await off.instance.call("pages.get", {
        params: { conversationId: params.conversationId, pageId: params.pageId }
      }),
      await off.instance.call("pages.files.get", { params, query: { path: "src/main.ts" } }),
      await off.instance.call("pages.preview", {
        params: { conversationId: params.conversationId, pageId: params.pageId },
        payload: {}
      })
    ];
    for (const answer of answers) {
      expect(answer.statusCode).toBe(404);
      expect(answer.json<ErrorBody>().error.details).toEqual(moduleOff);
    }
  });
});

describe("an assembled instance with the apps module on", () => {
  const config = (files: boolean) =>
    parseClientInstanceConfig({
      ...createTestConfig(),
      modules: { apps: { enabled: true } },
      infrastructure: {
        ...createTestConfig().infrastructure,
        ...(files ? { objectStorage: { files: { provider: "filesystem", root: filesRoot } } } : {})
      }
    });
  const secret = "a-secret-of-the-instance-with-enough-characters";

  it("does not start without the store its Pages keep their files in", async () => {
    await expect(
      createTestInstance({ config: config(false), env: { BETTER_AUTH_SECRET: secret }, tools: [] })
    ).rejects.toThrow(
      "'modules.apps.enabled' is true, but 'infrastructure.objectStorage.files' is not configured"
    );
  });

  it("does not start without a secret to derive the key of its content tokens from", async () => {
    await expect(createTestInstance({ config: config(true), env: {}, tools: [] })).rejects.toThrow(
      /neither of the secrets 'CHAT_SESSION_TOKEN_SECRET' and 'BETTER_AUTH_SECRET'/u
    );
    // A secret too short to sign with is no secret.
    await expect(
      createTestInstance({ config: config(true), env: { BETTER_AUTH_SECRET: "short" }, tools: [] })
    ).rejects.toThrow(/at least 32 characters/u);
  });

  it("starts with both and answers the Pages of a conversation", async () => {
    const instance = await createTestInstance({
      config: config(true),
      env: { BETTER_AUTH_SECRET: secret },
      tools: []
    });
    const created = await instance.call("conversations.create", { payload: { title: "Pages" } });
    const listed = await instance.call("pages.list", {
      params: { conversationId: created.json<{ id: string }>().id }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [] });
  });
});
