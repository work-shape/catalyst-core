import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAppKitFiles } from "@work-shape/catalyst-server";
import mainHashes from "./fixtures/app-kit-main-hashes.json";

const vendorRoot = "packages/server/vendor";
const kitRoot = join(vendorRoot, "app-kit");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("shared App Kit storage", () => {
  // The released kit as the server loads it, read once for the tests that only look at it.
  let released: ReturnType<typeof loadAppKitFiles>;
  beforeAll(() => {
    released = loadAppKitFiles();
  });

  it("preserves the hash of every served path on main, including the released manifests", () => {
    // Captured from main 0c6ad69d before moving a byte. Keep these retained versions frozen.
    const versions = released;
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
    for (const [version, files] of released) {
      for (const name of files.keys()) {
        if (name === "manifest.json") continue;
        const served = files.get(name);
        expect(served, `${version}/${name}`).toBeDefined();
        const hash = sha256(served?.bytes ?? Buffer.alloc(0));
        // Buffer.equals compares the bytes at once; toEqual walks them one by one, which took
        // most of this file's time.
        const stored = await readFile(join(vendorRoot, "app-kit-shared", hash));
        expect(stored.equals(served?.bytes ?? Buffer.alloc(0)), `${version}/${name}`).toBe(true);
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
      const react = released.get("1.0.0")?.get("react.js");
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

it.each(["startup", "release"])("refuses an unreferenced shared file at %s", async (target) => {
  const name = sha256(Buffer.from("unreferenced"));
  const parent = await mkdtemp(join(tmpdir(), "app-kit-stray-"));
  try {
    const vendor = join(parent, "packages/server/vendor");
    await cp(vendorRoot, vendor, { recursive: true });
    await writeFile(join(vendor, "app-kit-shared", name), "unreferenced");
    const error = `App Kit shared directory holds unreferenced files: ${name}. A released kit holds only files named by its manifests; restore the released files.`;
    if (target === "startup") {
      expect(() => loadAppKitFiles(join(vendor, "app-kit"))).toThrow(error);
      return;
    }

    const kit = join(parent, "packages/app-kit");
    await mkdir(join(kit, "scripts"), { recursive: true });
    await cp("packages/app-kit/scripts/release.mjs", join(kit, "scripts/release.mjs"));
    await symlink(resolve("packages/app-kit/node_modules"), join(kit, "node_modules"));
    const result = spawnSync(process.execPath, [join(kit, "scripts/release.mjs")], {
      encoding: "utf8"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
