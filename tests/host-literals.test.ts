import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanProductSource } from "./support/source-scan";

describe("provider addresses and secrets in product source", () => {
  const scanned = scanProductSource(resolve(import.meta.dirname, ".."));

  it("writes the address of a real host only inside an adapter", async () => {
    expect((await scanned).hostLiterals).toEqual([]);
  });

  it("reads no variable that is named as a secret", async () => {
    expect((await scanned).secretNamedEnvReads).toEqual([]);
  });

  it("reads the environment by a computed name only where listed, and a secret only in the resolver", async () => {
    expect([...new Set((await scanned).computedEnvReads)]).toEqual([
      // A numeric setting of the preview worker, read by its name.
      "packages/client-assembly/src/artifact-preview-worker.ts",
      // The sign-in address of a seed user. Its password comes from the resolver.
      "packages/client-assembly/src/auth.ts",
      "packages/config-cli/src/local-key.ts",
      // The secret resolver: the one place that reads a secret.
      "packages/core/src/secrets.ts",
      // The fixed list of variables the Docker client itself needs.
      "packages/tool-execution/src/docker-workspace-command-runner.ts"
    ]);
  });
});
