import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  composeViewDocument,
  viewRuntimeAddress,
  type ViewDocumentInput
} from "@vivd-catalyst/chat-ui";
import { stubViewHtmlParser } from "./view-html-parser";

stubViewHtmlParser();

// The frame document of a generated view is composed by the interface when the view is shown.
// Nothing of it is stored, so one composer serves new views and every view saved earlier.

const instanceOrigin = "https://chat.example.test";
const runtime = viewRuntimeAddress("", `${instanceOrigin}/chat/conv_1`);
const runtimeDirectory = `${instanceOrigin}/app-runtime/view/1/`;

// How every composed document begins: the policy before anything else.
const composedOpening = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy"';
const policyPattern = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/gu;
const outsideScript = "https://elsewhere.example.test/x.js";

function compose(html: string, input: Partial<ViewDocumentInput> = {}): string {
  return composeViewDocument({
    html,
    kind: "html.rendered",
    runtime,
    allowedScriptSrc: [],
    ...input
  });
}

describe("view runtime address", () => {
  it("is absolute whether the interface shares the API's origin or not", () => {
    expect(runtime).toEqual({
      directoryUrl: runtimeDirectory,
      tailwindUrl: `${runtimeDirectory}tailwind.js`,
      lucideUrl: `${runtimeDirectory}lucide.js`
    });
    // Two origins, as in local development and in the embedded widget on another site.
    expect(
      viewRuntimeAddress("http://localhost:4100/", "http://localhost:5173/").directoryUrl
    ).toBe("http://localhost:4100/app-runtime/view/1/");
    expect(
      viewRuntimeAddress("https://chat.example.test", "https://shop.example.test/help").tailwindUrl
    ).toBe(`${runtimeDirectory}tailwind.js`);
  });
});

describe("composed view document", () => {
  it("loads the runtime from the instance and names no other host", () => {
    const html = compose('<section class="p-4"><i data-lucide="chart-column"></i></section>');

    expect(scriptAddresses(html)).toEqual([
      `${runtimeDirectory}tailwind.js`,
      `${runtimeDirectory}lucide.js`
    ]);
    expect(hostsNamedIn(html)).toEqual([new URL(instanceOrigin).host]);
    expect(html).toContain('<section class="p-4"><i data-lucide="chart-column"></i></section>');
    expect(html).toContain("vivdCatalystTheme");
  });

  it("allows scripts from the runtime directory alone by default", () => {
    const scriptSrc = readCspDirective(compose("<section>View</section>"), "script-src");

    // The directory, not the origin: the API's origin also serves files people uploaded.
    expect(sourcesOf(scriptSrc)).toEqual([runtimeDirectory, "'unsafe-eval'"]);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("keeps the rest of the policy closed", () => {
    const csp = readCsp(compose("<section>View</section>"));

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("navigate-to 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("puts a host named in views.allowedScriptSrc into the policies and nowhere else", () => {
    const named = "https://cdn.jsdelivr.net";
    const html = compose('<canvas id="chart"></canvas>', { allowedScriptSrc: [named] });

    expect(sourcesOf(readCspDirective(html, "script-src"))).toEqual([
      runtimeDirectory,
      named,
      "'unsafe-eval'"
    ]);
    // Once in each of the two policies.
    expect(html.split(named)).toHaveLength(3);
    expect(scriptAddresses(html)).toEqual([
      `${runtimeDirectory}tailwind.js`,
      `${runtimeDirectory}lucide.js`
    ]);
  });

  it("allows every HTTPS host only when the instance config says so", () => {
    const html = compose("<section>View</section>", { allowedScriptSrc: ["https:"] });

    expect(sourcesOf(readCspDirective(html, "script-src"))).toEqual([
      runtimeDirectory,
      "https:",
      "'unsafe-eval'"
    ]);
  });

  it("gives a private-data view no library and no script host, whatever the setting says", () => {
    const html = compose("<script>window.ready = true;</script>", {
      kind: "private_hydrated_view",
      allowedScriptSrc: ["https:", "https://cdn.jsdelivr.net"]
    });
    const scriptSrc = readCspDirective(html, "script-src");

    expect(scriptAddresses(html)).toEqual([]);
    expect(hostsNamedIn(html)).toEqual([]);
    expect(sourcesOf(scriptSrc)).toEqual([]);
    expect(scriptSrc).toContain(scriptHashSource("window.ready = true;"));
    expect(readCsp(html)).toContain("connect-src 'none'");
  });

  it("replaces a content policy the stored HTML carries and hashes its inline scripts", () => {
    const inlineScript = "window.chartReady = true; // „Umsätze“";
    const html = compose(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>Chart</title></head><body><script>${inlineScript}</script></body></html>`
    );
    const csp = readCsp(html);

    expect(countOccurrences(html, "Content-Security-Policy")).toBe(2);
    expect(csp).not.toContain("script-src 'none'");
    expect(csp).toContain(scriptHashSource(inlineScript));
    expect(html).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/u);
  });

  it("holds script files to the allowed hosts in a second policy that names no hash", () => {
    const named = "https://cdn.jsdelivr.net";
    const cases = [
      {
        kind: "html.rendered",
        expected: [runtimeDirectory, named, "'unsafe-inline'", "'unsafe-eval'"]
      },
      { kind: "private_hydrated_view", expected: ["'unsafe-inline'"] }
    ] as const;

    for (const { kind, expected } of cases) {
      const html = compose("<section>View</section><script>window.ready = true;</script>", {
        kind,
        allowedScriptSrc: [named]
      });
      const policies = [...html.matchAll(policyPattern)].map((match) => match[1] ?? "");

      // A hash would let a script file of any host through by its integrity attribute.
      expect(policies).toHaveLength(2);
      expect(policies[0]).toContain("'sha256-");
      expect(policies[1]).toBe(`script-src ${expected.join(" ")}`);
      // Both stand before the first script of the document.
      expect(html.indexOf(policies[1] ?? "")).toBeLessThan(html.indexOf("<script"));
    }
  });

  it("allows every inline script it writes itself by hash", () => {
    const html = compose("<section>View</section>");
    const scriptSrc = readCspDirective(html, "script-src");
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(
      (match) => match[1] ?? ""
    );

    expect(inlineScripts.length).toBeGreaterThan(3);
    for (const script of inlineScripts) {
      expect(scriptSrc).toContain(scriptHashSource(script));
    }
  });

  it("writes its own head first and leaves the stored document whole behind it", () => {
    const stored = '<html lang="de"><body class="p-4"><p>Hallo</p></body></html>';
    const html = compose(stored);

    expect(html.startsWith(composedOpening)).toBe(true);
    expect(html.endsWith(`</head>\n${stored}`)).toBe(true);
  });

  // Each of these once moved the policy behind content, or left it out, because the stored
  // HTML was searched for the place to put it.
  it.each([
    [
      "a script file before the document",
      `<script src="${outsideScript}"></script><html><head><title>t</title></head><body>x</body></html>`
    ],
    [
      "an inline script before the document",
      `<script>fetch("${outsideScript}")</script><html><body>x</body></html>`
    ],
    [
      "a head tag inside a comment",
      `<!-- <head> --><html><head><script src="${outsideScript}"></script></head><body>x</body></html>`
    ],
    [
      "an html tag inside a comment",
      `<!-- <html> --><script src="${outsideScript}"></script><p>x</p>`
    ],
    [
      "a head tag inside an attribute",
      `<html><body data-x='<head>'><script src="${outsideScript}"></script></body></html>`
    ],
    [
      "a head tag inside a title",
      `<html><title><head></title><script src="${outsideScript}"></script><body>x</body></html>`
    ]
  ])("puts the policy before every byte of the stored HTML: %s", (_name, stored) => {
    for (const kind of ["html.rendered", "private_hydrated_view"] as const) {
      const html = compose(stored, { kind });

      expect(html.startsWith(composedOpening)).toBe(true);
      expect(countOccurrences(html, "Content-Security-Policy")).toBe(2);
      // The stored HTML follows the closed head, byte for byte.
      expect(html.slice(html.indexOf("</head>\n") + "</head>\n".length)).toBe(stored);
      expect(html.indexOf(composedOpening)).toBeLessThan(html.indexOf(stored));
      expect(sourcesOf(readCspDirective(html, "script-src"))).not.toContain(
        new URL(outsideScript).origin
      );
    }
  });

  it("provides semantic status and chart theme colors to Tailwind and the default theme", () => {
    const html = compose("<section>Status</section>");

    expect(html).toContain('const names=["background"');
    expect(html).toContain(
      '"destructive","success","warning","info","chart-1","chart-2","chart-3","chart-4","chart-5","border"'
    );
    expect(html).toContain("tailwind.config={theme:{extend:{colors,");
    expect(html).toContain("--primary: #1a1a1a;");
    expect(html).toContain("--background: #ffffff;");
    expect(html).toContain("--success: #047857;");
    expect(html).toContain("--warning: #b45309;");
    expect(html).toContain("--info: #0369a1;");
    expect(html).toContain("--chart-1: #0f766e;");
    expect(html).toContain("--chart-5: #be185d;");
    expect(html).toContain('success:color("success")');
    expect(html).toContain(
      'function chartPalette(){return[color("chart-1"),color("chart-2"),color("chart-3"),color("chart-4"),color("chart-5")]}'
    );
    expect(html).toContain("window.vivdCatalystTheme={color,chartColors,chartPalette}");
  });
});

describe("a view stored before the runtime moved onto the instance", () => {
  // What the tool of the earlier release stored: the model's HTML wrapped in a head with the
  // policy of that day and two script tags for two public hosts.
  const retiredHosts = ["cdn.tailwindcss.com", "unpkg.com"];
  const storedBootstrap = 'const vcThemeColorNames=["background"];tailwind.config={};';
  const stored = [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://cdn.tailwindcss.com https://unpkg.com https: 'unsafe-eval' 'sha256-old='; connect-src 'none'">`,
    '<style id="vivd-catalyst-default-theme">:root { --background: #ffffff; }</style>',
    '<script src="https://cdn.tailwindcss.com"></script>',
    `<script>${storedBootstrap}</script>`,
    '<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>',
    "</head>",
    '<body class="bg-background text-foreground antialiased">',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><canvas id="chart"></canvas>',
    "</body>",
    "</html>"
  ].join("\n");

  it("is shown under the policy of today, with the runtime from the instance", () => {
    const html = compose(stored);
    const scriptSrc = readCspDirective(html, "script-src");

    expect(countOccurrences(html, "Content-Security-Policy")).toBe(2);
    for (const host of retiredHosts) {
      expect(html).not.toContain(host);
    }
    expect(sourcesOf(scriptSrc)).toEqual([runtimeDirectory, "'unsafe-eval'"]);
    expect(scriptSrc).toContain(scriptHashSource(storedBootstrap));
    expect(scriptAddresses(html)).toEqual([
      `${runtimeDirectory}tailwind.js`,
      `${runtimeDirectory}lucide.js`,
      "https://cdn.jsdelivr.net/npm/chart.js"
    ]);
    // The view's own script tag stays; the policy decides whether it loads.
    expect(html).toContain('<canvas id="chart"></canvas>');
  });

  it("may load from a host once the instance names it, and no longer after it is removed", () => {
    const named = "https://cdn.jsdelivr.net";

    expect(
      sourcesOf(readCspDirective(compose(stored, { allowedScriptSrc: [named] }), "script-src"))
    ).toContain(named);
    expect(sourcesOf(readCspDirective(compose(stored), "script-src"))).not.toContain(named);
  });

  it("declares nothing in its own bootstrap that the stored copy declares again", () => {
    const html = compose(stored);
    const ownScripts = html.slice(0, html.indexOf(storedBootstrap));

    // Two classic scripts that both declare a top-level `const` of one name: the second throws.
    expect(ownScripts).not.toMatch(/<script>(?:const|let|class) /u);
    expect(ownScripts).not.toContain("vcThemeColorNames");
  });
});

function scriptAddresses(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gu)].map((match) => match[1] ?? "");
}

/** Every host any address in the document names, in the policy or in a tag. */
function hostsNamedIn(html: string): string[] {
  return Array.from(
    new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+)/giu)].map((match) => match[1] ?? ""))
  );
}

/** The directive's sources without the hashes of inline scripts. */
function sourcesOf(directive: string[]): string[] {
  return directive.filter((source) => !source.startsWith("'sha256-"));
}

function readCsp(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/u.exec(html);
  if (!match?.[1]) {
    throw new Error("Expected the composed document to include a CSP meta tag");
  }
  return match[1];
}

function readCspDirective(html: string, directiveName: string): string[] {
  const directive = readCsp(html)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directiveName} `));
  if (!directive) {
    throw new Error(`Expected the composed policy to include ${directiveName}`);
  }
  return directive.split(/\s+/u).slice(1);
}

function countOccurrences(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}

// Node's own digest: holds the interface's synchronous hash to the standard one.
function scriptHashSource(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}
