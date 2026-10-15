import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  kitFilePath,
  kitImportPath,
  kitStylesPlainPages,
  RELEASED_KIT_VERSIONS
} from "@work-shape/catalyst-app-build";
import { appKitFilesOf, deriveAppContentKey, loadAppKitFiles } from "@work-shape/catalyst-server";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { z } from "zod";
import { createTestConfig } from "./support/fixtures";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { callTestPath, createTestInstanceWith } from "./support/test-instance";

// The App Kit a Page loads is released code that ships with the instance: one frozen directory
// per version, each with a manifest of file hashes. A Page names its version and loads these
// files from the instance and from nowhere else.

const kitRoot = "packages/chat-server/vendor/app-kit";
const manifestSchema = z.object({
  version: z.string(),
  files: z.array(z.object({ file: z.string(), bytes: z.number(), sha256: z.string() })),
  libraries: z.array(z.object({ name: z.string(), version: z.string(), licence: z.string() }))
});

async function readManifest(version: string) {
  return manifestSchema.parse(
    JSON.parse(await readFile(join(kitRoot, version, "manifest.json"), "utf8"))
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startInstance(appsEnabled = true) {
  const config = parseClientInstanceConfig({
    ...createTestConfig(),
    modules: { apps: { enabled: appsEnabled } }
  });
  return createTestInstanceWith(() => ({
    config,
    modules: resolveInstanceModules(config, []).snapshot,
    pages: {
      objects: new MemoryObjectStorage(),
      contentKey: deriveAppContentKey("content-secret-".repeat(4))
    }
  }));
}

async function copyOfKit(change: (root: string) => Promise<void>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "app-kit-"));
  await cp(kitRoot, root, { recursive: true });
  await change(root);
  return root;
}

describe("the released App Kit versions", () => {
  it("holds a directory for every version a Page can be built against, each as its manifest records", async () => {
    const versions = (await readdir(kitRoot)).sort();

    expect(versions).toEqual([...RELEASED_KIT_VERSIONS].sort());
    for (const version of versions) {
      const manifest = await readManifest(version);
      expect(manifest.version).toBe(version);
      expect(manifest.files.map((file) => file.file).sort()).toEqual(
        [...appKitFilesOf(version)].sort()
      );
      for (const file of manifest.files) {
        const bytes = await readFile(join(kitRoot, version, file.file));
        expect({ file: file.file, bytes: bytes.byteLength, sha256: sha256(bytes) }).toEqual(file);
      }
      // Nothing lies in the directory that the manifest does not account for.
      expect((await readdir(join(kitRoot, version))).sort()).toEqual(
        ["manifest.json", ...appKitFilesOf(version)].sort()
      );
      for (const library of manifest.libraries) {
        expect(library.version).toMatch(/^\d+\.\d+\.\d+$/u);
      }
    }
  });

  it("answers every import name the build rewrites with a file of the version", async () => {
    for (const version of RELEASED_KIT_VERSIONS) {
      const files = loadAppKitFiles().get(version);
      for (const name of [
        "@work-shape/catalyst-app-kit",
        "@work-shape/catalyst-app-kit/ui",
        "@work-shape/catalyst-app-kit/charts",
        "@work-shape/catalyst-app-kit/router",
        "@tanstack/react-router",
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client"
      ]) {
        const path = kitImportPath(version, name);
        expect(path).toBeDefined();
        expect(files?.has(path?.split("/").at(-1) ?? "")).toBe(true);
      }
      // The stylesheet the document of a React Page links.
      expect(files?.has(kitFilePath(version, "ui.css").split("/").at(-1) ?? "")).toBe(true);
    }
  });

  it("names no host: the files reach each other by relative addresses only", async () => {
    for (const version of RELEASED_KIT_VERSIONS) {
      for (const file of appKitFilesOf(version).filter((name) => name.endsWith(".js"))) {
        const text = await readFile(join(kitRoot, version, file), "utf8");
        const imported = [
          ...text.matchAll(/\bfrom\s*"([^"]+)"/gu),
          ...text.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/gu),
          ...text.matchAll(/\bimport\s*"([^"]+)"/gu)
        ]
          .map((match) => match[1] ?? "")
          .filter((address) => address.startsWith(".") || address.includes("/"));
        for (const address of imported) {
          expect(address, `${file} imports ${address}`).toMatch(
            /^\.\/(?:kit|react|router|ui|charts)\.js$/u
          );
        }
      }
      const css = await readFile(join(kitRoot, version, "ui.css"), "utf8");
      expect(css).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//iu);
    }
  });

  it("holds a stylesheet for a plain Page without a utility class, whose base rules have no specificity", async () => {
    /** A selector without its `:where(...)` parts: what is left is what gives it specificity. */
    const outsideWhere = (selector: string): string => {
      let rest = "";
      let depth = 0;
      for (let index = 0; index < selector.length; index += 1) {
        if (depth === 0 && selector.startsWith(":where(", index)) {
          depth = 1;
          index += ":where(".length - 1;
        } else if (depth > 0) {
          depth += selector[index] === "(" ? 1 : selector[index] === ")" ? -1 : 0;
        } else {
          rest += selector[index];
        }
      }
      return rest;
    };

    for (const version of RELEASED_KIT_VERSIONS.filter(kitStylesPlainPages)) {
      const css = await readFile(join(kitRoot, version, "page.css"), "utf8");
      // The layer after the reset, where the base rules are, up to the brace that closes it.
      const layerStart = css.indexOf("@layer components{");
      expect(layerStart).toBeGreaterThan(css.indexOf("@layer base{"));
      let layerEnd = layerStart + "@layer components{".length;
      for (let depth = 1; depth > 0; layerEnd += 1) {
        depth += css[layerEnd] === "{" ? 1 : css[layerEnd] === "}" ? -1 : 0;
      }
      // The base rules all start at the document. The layer also holds the library's rules for
      // the scrollbar, which set nothing else.
      const rules = [...css.slice(layerStart, layerEnd).matchAll(/(?<=[{}])[^{}@]+(?=\{)/gu)]
        .map((rule) => rule[0])
        .filter((selector) => selector.startsWith(":where(html)"));
      expect(rules).toContain(":where(html) :where(body)");
      for (const selector of rules) {
        // No specificity, but for a pseudo-element, which cannot stand inside `:where()`.
        expect(outsideWhere(selector).replace("::placeholder", "").trim(), selector).toBe("");
      }
      // No utility class: a class name of an author means what the author's rule says. The
      // classes left are the library's own marks: for the mode, and for an icon and its size.
      expect(css).not.toContain("@layer utilities{");
      const classes = [
        ...css.replace(/\/\*[^]*?\*\//gu, "").matchAll(/\.(-?[A-Za-z_][\w-]*)(?=[^{}]*\{)/gu)
      ].map((match) => match[1]);
      expect([...new Set(classes)].sort()).toEqual(["dark", "lucide", "size-3"]);
      // The library's stylesheet holds its utilities and none of the base rules.
      const library = await readFile(join(kitRoot, version, "ui.css"), "utf8");
      expect(library).toContain("@layer utilities{");
      expect(library).not.toContain(":where(body)");
      // The theme script stands alone: it loads nothing of the kit.
      const theme = await readFile(join(kitRoot, version, "theme.js"), "utf8");
      expect(theme).not.toMatch(/\bfrom\s*"|\bimport\s*[("]/u);
    }
  });

  it("keeps the chart engine out of every file but its own, asked for by address", async () => {
    const [version] = RELEASED_KIT_VERSIONS;
    const ui = await readFile(join(kitRoot, version ?? "", "ui.js"), "utf8");
    const kit = await readFile(join(kitRoot, version ?? "", "kit.js"), "utf8");

    expect(ui).toContain('import("./charts.js")');
    // A static import would load the engine with every Page.
    expect(ui).not.toMatch(/from\s*"\.\/charts\.js"/u);
    expect(kit).not.toContain("charts.js");
  });
});

describe("loading the kit at startup", () => {
  it("refuses a file that is not the one its manifest pins", async () => {
    const root = await copyOfKit((copy) => appendFile(join(copy, "1.0.0", "kit.js"), "\n"));
    try {
      expect(() => loadAppKitFiles(root)).toThrow(
        /App Kit file '1\.0\.0\/kit\.js' has SHA-256 [0-9a-f]{64}, its manifest pins [0-9a-f]{64}/u
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a directory with a file its manifest does not name", async () => {
    const root = await copyOfKit((copy) => writeFile(join(copy, "1.0.0", "extra.js"), "0;"));
    try {
      expect(() => loadAppKitFiles(root)).toThrow(/App Kit directory '1\.0\.0' holds .*extra\.js/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a directory whose manifest names another version", async () => {
    const root = await copyOfKit((copy) =>
      cp(join(copy, "1.0.0"), join(copy, "9.9.9"), { recursive: true })
    );
    try {
      expect(() => loadAppKitFiles(root)).toThrow(
        "App Kit manifest in '9.9.9' names version '1.0.0'"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the kit route", () => {
  it("serves every file of a version to anyone, to be kept for good, across origins", async () => {
    const instance = await startInstance();
    const manifest = await readManifest("1.0.0");

    for (const file of manifest.files) {
      const response = await callTestPath(instance, "GET", kitFilePath("1.0.0", file.file), {
        "sec-fetch-dest": file.file.endsWith(".css") ? "style" : "script"
      });

      expect(response.statusCode).toBe(200);
      expect(sha256(response.rawPayload)).toBe(file.sha256);
      expect(response.headers).toMatchObject({
        "content-type": file.file.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "cross-origin",
        "access-control-allow-origin": "*"
      });
    }
    const listed = await callTestPath(instance, "GET", kitFilePath("1.0.0", "manifest.json"));
    expect(listed.json<{ version: string }>().version).toBe("1.0.0");
  });

  it("answers a version this release does not hold with 404 kit_unavailable", async () => {
    const instance = await startInstance();

    const response = await callTestPath(instance, "GET", kitFilePath("7.0.0", "kit.js"));

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", details: { reason: "kit_unavailable" } }
    });
  });

  it("serves nothing a version does not hold", async () => {
    const instance = await startInstance();

    for (const file of ["missing.js", "sub/kit.js", "kit.js/kit.js", "KIT.js", ""]) {
      const response = await callTestPath(instance, "GET", `/app-runtime/kit/1.0.0/${file}`);
      expect(response.statusCode, file).toBe(404);
    }
  });

  it("answers 404 module_off with the apps module off", async () => {
    const instance = await startInstance(false);

    const response = await callTestPath(instance, "GET", kitFilePath("1.0.0", "kit.js"));

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { details: { reason: "module_off", module: "apps" } }
    });
  });
});
