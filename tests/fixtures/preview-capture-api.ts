import { rewriteHtml } from "@work-shape/catalyst-app-build/build";
// A local-only API peer: real Page shell/CSP/guard and immutable released kit bytes.
import { createServer } from "node:http";
import { composePageShell, appContentHeaders } from "@work-shape/catalyst-server";
import { loadAppKitFiles } from "@work-shape/catalyst-server";
const files = loadAppKitFiles("/vendor/app-kit");
const version = [...files.keys()].at(-1);
if (!version) throw new Error("No released kit");
let html = "<h1>Plain Page</h1>";
let scripts = new Map<string, { text: string; kind: string }>();
const served: string[] = [];
const handle = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse
) => {
  const path = request.url ?? "/";
  if (path === "/fixture" && request.method === "POST") {
    let body = "";
    for await (const part of request) body += part;
    const built = rewriteHtml({
      path: "index.html",
      kitVersion: version,
      html: body.replaceAll("KIT_VERSION", version),
      exists: () => false
    });
    html = built.html;
    scripts = new Map(
      built.extracted.map((file) => [file.path, { text: file.text, kind: file.kind }])
    );
    served.length = 0;
    response.end("ok");
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
