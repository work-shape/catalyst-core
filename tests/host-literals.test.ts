import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { productSourceScan, scanProductSource } from "./support/source-scan";

describe("provider addresses and secrets in product source", () => {
  const scanned = productSourceScan;

  it("writes the address of a real host only inside an adapter", async () => {
    expect((await scanned).hostLiterals).toEqual([]);
  });

  it("reads no variable that is named as a secret", async () => {
    expect((await scanned).secretNamedEnvReads).toEqual([]);
  });

  it("reads the environment by a computed name only where listed, and a secret only in the resolver", async () => {
    expect([...new Set((await scanned).computedEnvReads)]).toEqual([
      // The sign-in address of the seeded superadmin. Every password and key the seed reads
      // comes from the resolver.
      "clients/demo/src/seed/run.ts",
      // A numeric setting of the preview worker, read by its name.
      "packages/client-assembly/src/artifact-preview-worker.ts",
      // The sign-in address of a seed user. Its password comes from the resolver.
      "packages/client-assembly/src/auth.ts",
      // The sign-in address of the seeded superadmin, for a key on a local instance.
      "packages/client-assembly/src/local-key.ts",
      // The secret resolver: the one place that reads a secret.
      "packages/core/src/secrets.ts",
      // The fixed list of variables the Docker client itself needs.
      "packages/tool-execution/src/docker-workspace-command-runner.ts"
    ]);
  });
});

// A distinct host per form means another spelling cannot mask a missed match.
it("finds outside hosts in browser URL forms and bare CDN guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-literals-"));
  const file = "packages/tool-execution/src/built-in-tools.ts";
  const outside = [
    "https://explicit.invalid-cdn.net/library",
    "//relative.invalid-cdn.net/library",
    String.raw`\\backslash.invalid-cdn.net/library`,
    String.raw`/\mixed.invalid-cdn.net/library`,
    "HtTpS://UPPER.INVALID-CDN.NET/library",
    "HTTP://http.invalid-cdn.net/library",
    "https:/single.invalid-cdn.net/library",
    String.raw`\\intranet/library`,
    "unpkg.com",
    "CDN.TAILWINDCSS.COM"
  ];
  const source = outside
    .map((url, index) => `const url${index} = ${JSON.stringify(url)};`)
    .join("\n");
  try {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), source);
    expect((await scanProductSource(root)).hostLiterals).toEqual(
      [
        "explicit.invalid-cdn.net",
        "upper.invalid-cdn.net",
        "http.invalid-cdn.net",
        "unpkg.com",
        "cdn.tailwindcss.com",
        "relative.invalid-cdn.net",
        "backslash.invalid-cdn.net",
        "mixed.invalid-cdn.net",
        "single.invalid-cdn.net",
        "intranet"
      ].map((host) => `${file} ${host}`)
    );

    // The same URL forms remain legal for adapters and reserved test hosts.
    await mkdir(join(root, "packages/example/src/adapters"), { recursive: true });
    await writeFile(join(root, "packages/example/src/adapters/provider.ts"), source);
    await writeFile(
      join(root, file),
      [
        "//localhost/library",
        "HTTPS://EXAMPLE.COM/library",
        String.raw`\\example.test/library`,
        "//127.0.0.1/library",
        "HTTP://schemas.example.org/identifier",
        "https://git-lfs",
        "path://M0 0L2 0L1 2Z",
        "postgres://host:port/database"
      ]
        .map((url, index) => `const url${index} = ${JSON.stringify(url)};`)
        .join("\n")
    );
    expect((await scanProductSource(root)).hostLiterals).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
