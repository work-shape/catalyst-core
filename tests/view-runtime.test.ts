import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_RUNTIME } from "@vivd-catalyst/api-contract";
import { loadViewRuntimeFiles } from "@vivd-catalyst/chat-server";
import { z } from "zod";
import { createTestInstance } from "./support/test-instance";

// The runtime a generated view loads is pinned third-party code that ships in the release.
// Each version directory has a manifest: where every file came from, its hash, its licence.

const runtimeRoot = "packages/chat-server/vendor/view-runtime";
const manifestSchema = z.object({
  version: z.string(),
  files: z.array(
    z.object({
      file: z.string(),
      library: z.string(),
      libraryVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
      source: z.url(),
      sha256: z.string(),
      licence: z.enum(["MIT", "ISC"]),
      licenceFile: z.string(),
      licenceSource: z.url()
    })
  )
});

async function readManifest(version: string) {
  return manifestSchema.parse(
    JSON.parse(await readFile(join(runtimeRoot, version, "manifest.json"), "utf8"))
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("view runtime", () => {
  it("holds every pinned file to the hash its manifest records", async () => {
    const versions = await readdir(runtimeRoot);

    expect(versions).toContain(VIEW_RUNTIME.version);
    for (const version of versions) {
      const manifest = await readManifest(version);
      expect(manifest.version).toBe(version);
      for (const file of manifest.files) {
        expect({
          file: file.file,
          sha256: sha256(await readFile(join(runtimeRoot, version, file.file)))
        }).toEqual({ file: file.file, sha256: file.sha256 });
        // The exact version, never a moving address.
        expect(file.source).toContain(file.libraryVersion);
        expect(file.source).not.toContain("latest");
        expect(
          (await readFile(join(runtimeRoot, version, file.licenceFile), "utf8")).length
        ).toBeGreaterThan(500);
      }
      // Nothing lies in the directory that the manifest does not account for.
      expect((await readdir(join(runtimeRoot, version))).sort()).toEqual(
        ["manifest.json", ...manifest.files.flatMap((file) => [file.file, file.licenceFile])].sort()
      );
    }
  });

  it("pins the two files the interface asks for", async () => {
    const manifest = await readManifest(VIEW_RUNTIME.version);

    expect(manifest.files.map((file) => file.file).sort()).toEqual(
      [VIEW_RUNTIME.lucideFile, VIEW_RUNTIME.tailwindFile].sort()
    );
  });

  it("refuses to start with a file that is not the one its manifest pins", async () => {
    const root = await mkdtemp(join(tmpdir(), "view-runtime-"));
    try {
      await cp(runtimeRoot, root, { recursive: true });
      expect(loadViewRuntimeFiles(root).get(VIEW_RUNTIME.version)?.size).toBe(4);

      await appendFile(join(root, VIEW_RUNTIME.version, VIEW_RUNTIME.lucideFile), "\n");

      expect(() => loadViewRuntimeFiles(root)).toThrow(
        /View runtime file '1\/lucide\.js' has SHA-256 [0-9a-f]{64}, its manifest pins [0-9a-f]{64}/u
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves the pinned files to anyone, to be kept for good", async () => {
    const instance = await createTestInstance();
    const manifest = await readManifest(VIEW_RUNTIME.version);

    for (const file of manifest.files) {
      const response = await instance.call("view_runtime.files.get", {
        params: { version: VIEW_RUNTIME.version, file: file.file }
      });

      expect(response.statusCode).toBe(200);
      expect(sha256(response.rawPayload)).toBe(file.sha256);
      expect(response.headers).toMatchObject({
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "cross-origin"
      });

      const licence = await instance.call("view_runtime.files.get", {
        params: { version: VIEW_RUNTIME.version, file: file.licenceFile }
      });
      expect(licence.statusCode).toBe(200);
      expect(licence.headers["content-type"]).toBe("text/plain; charset=utf-8");
    }
  });

  it("serves nothing outside what a manifest names", async () => {
    const instance = await createTestInstance();

    for (const params of [
      { version: VIEW_RUNTIME.version, file: "manifest.json" },
      { version: VIEW_RUNTIME.version, file: "../1/tailwind.js" },
      { version: VIEW_RUNTIME.version, file: "missing.js" },
      { version: "0", file: VIEW_RUNTIME.tailwindFile }
    ]) {
      const response = await instance.call("view_runtime.files.get", { params });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });
});
