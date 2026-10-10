import { runInThisContext } from "node:vm";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PageBuildResult, PageFile } from "@vivd-catalyst/app-build";
import { buildPage, parsePageManifest } from "@vivd-catalyst/app-build/build";
import { fileRoute, htmlManifest, pageFiles, reactManifest, rootRoute } from "./support/page-build";
import { refuseNetwork } from "./support/refuse-network";

const decoder = new TextDecoder();

function built(result: PageBuildResult): Map<string, string> {
  if (result.status !== "built") {
    throw new Error(`The Page did not build: ${JSON.stringify(result.errors)}`);
  }
  return new Map(result.files.map((file) => [file.path, decoder.decode(file.bytes)]));
}

function errorsOf(result: PageBuildResult) {
  if (result.status !== "errors") {
    throw new Error("The Page built");
  }
  return result.errors;
}

function reactPage(routes: Record<string, string>): PageFile[] {
  return pageFiles({
    "app.yaml": reactManifest,
    "src/routes/__root.tsx": rootRoute,
    ...Object.fromEntries(
      Object.entries(routes).map(([name, text]) => [`src/routes/${name}`, text])
    )
  });
}

describe("a React Page", () => {
  it("builds to one script that imports the kit from the instance and names no host", async () => {
    const result = await buildPage({
      files: [
        ...reactPage({
          "index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@work-shape/catalyst-app-kit/ui";
import { double } from "../shared/math";
import "../styles.css";
export const Route = createFileRoute("/")({ component: Home });
function Home() {
  const [count, setCount] = useState(1);
  return <Button onClick={() => setCount(double(count))}>{count}</Button>;
}
`,
          "history.tsx": fileRoute("/history")
        }),
        ...pageFiles({
          "src/shared/math.ts": "export const double = (value: number): number => value * 2;\n",
          "src/styles.css": ".page { color: red }\n",
          "assets/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
          "actions/list.sql": "select 1",
          "schemas/list.json": "{}",
          "README.md": "# Demo"
        })
      ]
    });
    const files = built(result);

    expect([...files.keys()].sort()).toEqual([
      "app.css",
      "app.js",
      "assets/logo.svg",
      "index.html"
    ]);
    const script = files.get("app.js") ?? "";
    expect(script).toContain('"/app-runtime/kit/1.0.0/react.js"');
    expect(script).toContain('"/app-runtime/kit/1.0.0/router.js"');
    expect(script).toContain('"/app-runtime/kit/1.0.0/ui.js"');
    expect(script).toContain('"/app-runtime/kit/1.0.0/kit.js"');
    // One script: nothing is fetched later, and nothing of the kit is inside it.
    expect(script).not.toMatch(/import\(/u);
    expect(script).not.toMatch(/https?:\/\//u);
    expect(script).not.toContain("@work-shape/catalyst-app-kit");
    const html = files.get("index.html") ?? "";
    expect(html).toContain('<script type="module" src="./app.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="./app.css">');
    expect(html).not.toMatch(/https?:\/\//u);
    expect(result).toMatchObject({
      kitVersion: "1.0.0",
      manifest: {
        id: "demo-page",
        entry: "index.html",
        pages: [{ path: "/" }, { path: "/history" }]
      }
    });
  });

  it("reports a syntax error with its file and line, also in a file no route imports", async () => {
    const result = await buildPage({
      files: reactPage({
        "index.tsx": fileRoute("/"),
        "history.tsx": `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/history")({
  component: () => <p>History</p
});
`
      })
    });

    expect(errorsOf(result)).toEqual([
      expect.objectContaining({ file: "src/routes/history.tsx", line: 4, code: "syntax" })
    ]);

    const unused = await buildPage({
      files: [
        ...reactPage({ "index.tsx": fileRoute("/") }),
        ...pageFiles({ "src/shared/unused.ts": "export const broken = ;\n" })
      ]
    });
    expect(errorsOf(unused)).toEqual([
      expect.objectContaining({ file: "src/shared/unused.ts", line: 1 })
    ]);
  });

  it("refuses an import that is neither a file of the Page nor of the kit", async () => {
    const result = await buildPage({
      files: reactPage({
        "index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import chunk from "lodash/chunk";
import { secret } from "../../../outside";
import remote from "https://example.com/module.js";
export const Route = createFileRoute("/")({ component: () => <p>{chunk([secret, remote], 1)}</p> });
`
      })
    });

    expect(errorsOf(result)).toEqual([
      expect.objectContaining({
        file: "src/routes/index.tsx",
        line: 2,
        code: "import_unavailable"
      }),
      expect.objectContaining({
        file: "src/routes/index.tsx",
        line: 3,
        code: "import_unavailable"
      }),
      expect.objectContaining({
        file: "src/routes/index.tsx",
        line: 4,
        code: "import_unavailable"
      })
    ]);
  });
});

describe("a build never runs a file of the Page", () => {
  let directory: string;
  let restoreNetwork: (() => void) | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "page-bundle-test-"));
  });
  afterAll(async () => {
    restoreNetwork?.();
    await rm(directory, { recursive: true, force: true });
  });

  // Needs no import, so the bundler takes the file, and writes the marker wherever Node runs it.
  const writeMarker = (marker: string) =>
    `globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`;
  const hostileRoute = (
    marker: string
  ) => `import { createFileRoute } from "@tanstack/react-router";
${writeMarker(marker)}
throw new Error("thrown at import");
export const Route = createFileRoute("/")({ component: () => <p>never</p> });
`;

  it("has a marker statement that writes its file when it is run", () => {
    const marker = join(directory, "marker-control");
    runInThisContext(writeMarker(marker));
    expect(existsSync(marker)).toBe(true);
  });

  it("builds a route that throws at import and writes a file, with the network refused", async () => {
    const marker = join(directory, "marker-in-process");
    // Refused for the route generator and the bundler alike: a build that opened a socket
    // would fail here.
    restoreNetwork = refuseNetwork();
    expect(() => net.connect(9, "192.0.2.1")).toThrow("opens no network connection");
    try {
      const result = await buildPage({
        files: reactPage({ "index.tsx": hostileRoute(marker) })
      });

      expect(result.status).toBe("built");
      expect(existsSync(marker)).toBe(false);
      // The statement is in the built script, as text for a browser.
      expect(built(result).get("app.js")).toContain("thrown at import");
    } finally {
      restoreNetwork();
      restoreNetwork = undefined;
    }
  });

  // The generator imports and runs a file whose name ends in `__virtual` and a script
  // extension, wherever it lies below the routes. Its pattern tests the end of the name, so a
  // prefixed name is such a file too. Each of these ran its code before the refusal matched
  // the generator's own pattern.
  it.each([
    "src/routes/__virtual.ts",
    "src/routes/a__virtual.js",
    "src/routes/sub/a__virtual.js",
    "src/routes/sub/deeper/route__virtual.mts",
    "src/routes/sub/__virtual.cjs",
    "src/lib/a__virtual.js"
  ])("refuses %s, a name the route generator would execute, and does not run it", async (path) => {
    const marker = join(directory, `marker-${path.replaceAll("/", "-")}`);
    const result = await buildPage({
      files: [
        ...reactPage({ "index.tsx": fileRoute("/") }),
        ...pageFiles({ [path]: `${writeMarker(marker)}\nexport default [];\n` })
      ]
    });

    expect(errorsOf(result)).toEqual([
      expect.objectContaining({ file: path, code: "routes_invalid" })
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("builds a Page whose file names only resemble that name", async () => {
    const marker = join(directory, "marker-resembling");
    const result = await buildPage({
      files: [
        ...reactPage({ "index.tsx": fileRoute("/") }),
        ...pageFiles({
          "src/routes/__virtual.txt": writeMarker(marker),
          "src/lib/virtual.ts": `export const note = "plain";\n${writeMarker(marker)}\n`
        })
      ]
    });

    expect(result.status).toBe("built");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a plain HTML Page", () => {
  const page = (html: string, more: Record<string, string> = {}) =>
    pageFiles({ "app.yaml": htmlManifest, "index.html": html, ...more });

  it("moves an inline script and an inline style into files the HTML loads", async () => {
    const result = await buildPage({
      files: page(`<!doctype html>
<html>
  <head>
    <title>Calculator</title>
    <style media="screen">
      body { color: teal; }
    </style>
  </head>
  <body>
    <button id="add">Add</button>
    <script>
      document.getElementById("add").addEventListener("click", () => { document.title = "added"; });
    </script>
  </body>
</html>
`)
    });
    const files = built(result);

    expect([...files.keys()].sort()).toEqual([
      "index.html",
      "index.inline-1.css",
      "index.inline-2.js"
    ]);
    const html = files.get("index.html") ?? "";
    expect(html).not.toMatch(/<style/u);
    expect(html).not.toContain("addEventListener");
    expect(html).toContain('<link rel="stylesheet" href="./index.inline-1.css" media="screen">');
    expect(html).toContain('<script src="./index.inline-2.js"></script>');
    expect(html).toContain('<button id="add">Add</button>');
    expect(files.get("index.inline-1.css")).toContain("color: teal");
    expect(files.get("index.inline-2.js")).toContain('document.title = "added"');
    expect(result).toMatchObject({ manifest: { entry: "index.html" } });
    expect(result.status === "built" && "pages" in result.manifest).toBe(false);
  });

  it("refuses an inline event handler with file, element and attribute, and builds once it is a listener", async () => {
    const refused = await buildPage({
      files: page(`<!doctype html>
<body>
  <button onclick="x()">Go</button>
</body>
`)
    });

    expect(errorsOf(refused)).toEqual([
      expect.objectContaining({
        code: "inline_event_handler",
        file: "index.html",
        line: 3,
        element: "button",
        attribute: "onclick"
      })
    ]);

    const fixed = await buildPage({
      files: page(
        `<!doctype html>
<body>
  <button id="go">Go</button>
  <script src="./main.js"></script>
</body>
`,
        { "main.js": 'document.getElementById("go").addEventListener("click", () => x());\n' }
      )
    });
    expect([...built(fixed).keys()].sort()).toEqual(["index.html", "main.js"]);
  });

  it("bundles a module script and reports an error in an inline one at its line of the HTML", async () => {
    const result = await buildPage({
      files: page(
        `<!doctype html>
<body>
  <script type="module" src="./src/main.ts"></script>
  <script type="module">
    import { greet } from "./src/greet";
    greet();
  </script>
</body>
`,
        {
          "src/main.ts": 'import { greet } from "./greet";\ngreet();\n',
          "src/greet.ts": 'export const greet = (): void => { document.title = "hi"; };\n'
        }
      )
    });
    const files = built(result);

    expect([...files.keys()].sort()).toEqual(["index.html", "index.inline-1.js", "src/main.js"]);
    expect(files.get("index.html")).toContain(
      '<script type="module" src="./src/main.js"></script>'
    );
    expect(files.get("index.html")).toContain(
      '<script type="module" src="./index.inline-1.js"></script>'
    );
    expect(files.get("src/main.js")).toContain("hi");

    const broken = await buildPage({
      files: page(`<!doctype html>
<body>
  <script>
    const ok = 1;
    const broken = ;
  </script>
</body>
`)
    });
    expect(errorsOf(broken)).toEqual([
      expect.objectContaining({ file: "index.html", line: 5, code: "syntax" })
    ]);
  });

  it("refuses a script and a style sheet from another host", async () => {
    const result = await buildPage({
      files: page(`<!doctype html>
<head>
  <link rel="stylesheet" href="https://cdn.example.com/site.css">
  <script src="https://cdn.example.com/lib.js"></script>
  <script src="//cdn.example.com/lib.js"></script>
</head>
`)
    });

    expect(errorsOf(result).map((error) => [error.code, error.element, error.line])).toEqual([
      ["external_resource", "link", 3],
      ["external_resource", "script", 4],
      ["external_resource", "script", 5]
    ]);
  });
});

describe("the manifest", () => {
  const manifestErrors = (text: string) => {
    const parsed = parsePageManifest(new TextEncoder().encode(text));
    return parsed.status === "errors" ? parsed.errors.map((error) => error.message) : [];
  };

  it("accepts the keys of a Page and stores connections and actions as written", () => {
    const parsed = parsePageManifest(
      new TextEncoder().encode(`id: brutto-netto
name: Brutto-Netto-Rechner
description: Rechnet Brutto in Netto um.
icon: calculator
kit: 1.0.0
connections: [exampledata]
actions:
  - { name: list_records, file: actions/list_records.sql, effect: reading, cache: { ttl: 60, scope: user } }
externalHosts: [api.example.com]
`)
    );

    expect(parsed).toMatchObject({
      status: "valid",
      manifest: {
        connections: ["exampledata"],
        actions: [{ name: "list_records", effect: "reading", cache: { ttl: 60, scope: "user" } }],
        externalHosts: ["api.example.com"]
      }
    });
  });

  it("refuses an unknown key, a kit version that was not released and a host that is no plain name", () => {
    expect(manifestErrors("id: a\nname: A\nkit: 1.0.0\npages: []\nowner: me\n")).toEqual([
      expect.stringMatching(
        /Unknown keys 'pages', 'owner'.*derived from the files under src\/routes/u
      )
    ]);
    expect(manifestErrors("id: a\nname: A\nkit: ^1.0.0\n")).toEqual([
      expect.stringContaining("an exact released kit version: 1.0.0")
    ]);
    expect(manifestErrors("id: a\nname: A\nkit: 9.9.9\n")).toHaveLength(1);
    for (const host of [
      "'*.example.com'",
      "https://example.com",
      "example.com:8443",
      "example.com/path"
    ]) {
      expect(manifestErrors(`id: a\nname: A\nkit: 1.0.0\nexternalHosts: [${host}]\n`)).toHaveLength(
        1
      );
    }
    expect(manifestErrors("id: a\nname: [unclosed\n")).toEqual([
      expect.stringContaining("not valid YAML")
    ]);
  });

  it("is required, and a file with a path a Page cannot hold stops the build", async () => {
    expect(errorsOf(await buildPage({ files: pageFiles({ "index.html": "<p>x</p>" }) }))).toEqual([
      expect.objectContaining({ file: "app.yaml", code: "manifest_invalid" })
    ]);
    const hostile = await buildPage({
      files: pageFiles({
        "app.yaml": htmlManifest,
        "index.html": "<p>x</p>",
        "../outside.js": "1",
        "/etc/passwd": "1",
        "nested/__catalyst/guard.js": "1"
      })
    });
    expect(errorsOf(hostile).map((error) => [error.file, error.code])).toEqual([
      ["../outside.js", "file_invalid"],
      ["/etc/passwd", "file_invalid"],
      ["nested/__catalyst/guard.js", "file_invalid"]
    ]);
  });
});
