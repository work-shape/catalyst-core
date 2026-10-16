import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAppKitFiles } from "@work-shape/catalyst-server";
import mainHashes from "./fixtures/app-kit-main-hashes.json";

const vendorRoot = "packages/server/vendor";
const kitRoot = join(vendorRoot, "app-kit");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("shared App Kit storage", () => {
  it("preserves the hash of every served path on main, including the released manifests", () => {
    // Captured from main 0c6ad69d before moving a byte. Keep these retained versions frozen.
    const versions = loadAppKitFiles();
    for (const [path, hash] of Object.entries(mainHashes)) {
      const [version, file] = path.split("/");
      const served = versions.get(version ?? "")?.get(file ?? "");
      expect(served, path).toBeDefined();
      expect(sha256(served?.bytes ?? Buffer.alloc(0)), path).toBe(hash);
    }
  });

  it("stores each pinned file once under its content hash", async () => {
    const hashes = new Set<string>();
    let references = 0;
    for (const [version, files] of loadAppKitFiles()) {
      for (const name of files.keys()) {
        if (name === "manifest.json") continue;
        const served = files.get(name);
        expect(served, `${version}/${name}`).toBeDefined();
        const hash = sha256(served?.bytes ?? Buffer.alloc(0));
        expect(await readFile(join(vendorRoot, "app-kit-shared", hash))).toEqual(served?.bytes);
        expect(await readdir(join(kitRoot, version))).not.toContain(name);
        hashes.add(hash);
        references += 1;
      }
    }
    expect((await readdir(join(vendorRoot, "app-kit-shared"))).sort()).toEqual([...hashes].sort());
    expect(hashes.size).toBeLessThan(references);
  });

  it.each(["changed", "missing"])("refuses a %s shared file at startup", async (damage) => {
    const parent = await mkdtemp(join(tmpdir(), "app-kit-shared-"));
    try {
      const root = join(parent, "app-kit");
      await cp(kitRoot, root, { recursive: true });
      await cp(join(vendorRoot, "app-kit-shared"), join(parent, "app-kit-shared"), {
        recursive: true
      });
      const react = loadAppKitFiles().get("1.0.0")?.get("react.js");
      expect(react).toBeDefined();
      const path = join(parent, "app-kit-shared", sha256(react?.bytes ?? Buffer.alloc(0)));
      if (damage === "changed") await writeFile(path, "damaged");
      else await rm(path);
      expect(() => loadAppKitFiles(root)).toThrow(
        damage === "changed" ? /App Kit file '1\.0\.0\/react\.js' has SHA-256/u : /ENOENT/u
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
