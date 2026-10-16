import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkXlsxIntegrity } from "../scripts/release/check-lock-integrity.mjs";

const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const integrity = /integrity: sha512-oLDq3jw7[^,}\s]+/u;

describe("SheetJS lock integrity", () => {
  it("pins the upstream tarball in the committed lock", () => {
    expect(() => checkXlsxIntegrity(lock)).not.toThrow();
  });

  it("rejects a URL resolution whose integrity was dropped", () => {
    const withoutIntegrity = lock.replace(/integrity: sha512-oLDq3jw7[^,}\s]+, /u, "");
    expect(() => checkXlsxIntegrity(withoutIntegrity)).toThrow(
      "SheetJS lock integrity is missing or changed"
    );
  });

  it("rejects a changed tarball checksum", () => {
    expect(() => checkXlsxIntegrity(lock.replace(integrity, "integrity: sha512-changed"))).toThrow(
      "SheetJS lock integrity is missing or changed"
    );
  });

  it("rejects a missing package entry", () => {
    expect(() => checkXlsxIntegrity("packages: {}\n")).toThrow(
      "SheetJS lock integrity is missing or changed"
    );
  });
});
