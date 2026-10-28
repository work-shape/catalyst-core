import { rewriteHtml } from "@work-shape/catalyst-app-build/build";
// A local-only API peer: real Page shell/CSP/guard and immutable released kit bytes.
import { createServer } from "node:http";
import { composePageShell, appContentHeaders } from "@work-shape/catalyst-server";
import { loadAppKitFiles } from "@work-shape/catalyst-server";
const files = loadAppKitFiles("/vendor/app-kit");
const version = [...files.keys()].at(-1);
if (!version) throw new Error("No released kit");
const fixtures = new Map<
  string,
  {
    html: string;
    scripts: Map<string, { text: string; kind: string }>;
    waiting: boolean;
    released: Promise<void>;
    release: () => void;
  }
>();
const served: string[] = [];
const handle = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse
) => {
  const path = request.url ?? "/";
  if (path.startsWith("/fixture/") && request.method === "POST") {
    let body = "";
    for await (const part of request) body += part;
    const input: { html: string; hold: boolean } = JSON.parse(body);
    const built = rewriteHtml({
      path: "index.html",
      kitVersion: version,
      html: input.html.replaceAll("KIT_VERSION", version),
      exists: () => false
    });
    let release = () => {};
    const released = input.hold
      ? new Promise<void>((done) => {
          release = done;
        })
      : Promise.resolve();
    fixtures.set(path.slice("/fixture/".length), {
      html: built.html,
      scripts: new Map(
        built.extracted.map((file) => [file.path, { text: file.text, kind: file.kind }])
      ),
      waiting: false,
      released,
      release
    });
    served.length = 0;
    response.end("ok");
    return;
  }
  if (path.startsWith("/release/")) {
    fixtures.get(path.slice("/release/".length))?.release();
    response.end("ok");
    return;
  }
  if (path.startsWith("/waiting/")) {
    response.end(JSON.stringify(fixtures.get(path.slice("/waiting/".length))?.waiting ?? false));
    return;
  }
  if (path === "/served") {
    response.end(JSON.stringify(served));
    return;
  }
  served.push(path.replace(/(\/app-content\/[^/]+\/)[^/]+/u, "$1…"));
  if (path.startsWith("/app-runtime/kit/")) {
    const [v, ...segments] = path.slice("/app-runtime/kit/".length).split("/");
    const file = files.get(v ?? "")?.get(segments.join("/"));
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("content-type", file.contentType);
    response.setHeader("access-control-allow-origin", "*");
    response.end(file.bytes);
    return;
  }
  if (path.startsWith("/app-content/")) {
    const fixture = fixtures.get(path.split("/")[3] ?? "");
    if (!fixture) throw new Error("No fixture");
    const { html, scripts } = fixture;
    const name = path.split("/").slice(4).join("/");
    if (scripts.has(name)) {
      response.setHeader(
        "content-type",
        scripts.get(name)?.kind === "style" ? "text/css" : "text/javascript"
      );
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("cross-origin-resource-policy", "cross-origin");
      response.end(scripts.get(name)?.text);
      return;
    }
    fixture.waiting = true;
    await fixture.released;
    const session = "capture:pcap_fixture";
    const shell = composePageShell(html, { session, values: {}, persistent: false });
    for (const [key, value] of Object.entries(
      appContentHeaders(["http://interface.invalid"], {
        pageScriptHash: shell.pageScriptHash,
        outsideHosts: ["outside.example"]
      })
    ))
      response.setHeader(key, value);
    response.setHeader("content-type", "text/html");
    response.end(shell.document);
    return;
  }
  response.writeHead(404);
  response.end();
};
createServer((request, response) => {
  handle(request, response).catch(() => {
    response.destroy();
  });
}).listen(4100, "0.0.0.0");
