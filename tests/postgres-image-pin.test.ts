import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The instance's Postgres image is pinned once, in docker/postgres/pinned-image, and every
// file of this repository that starts it names the same digest (ADR-0023).

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const pinned = read("docker/postgres/pinned-image")
  .split("\n")
  .find((line) => line.trim() !== "" && !line.startsWith("#"));

function postgresImageOf(composeFile: string): string | undefined {
  const service = read(composeFile)
    .split("\n  postgres:\n")[1]
    ?.split(/\n  [\w-]+:\n/u)[0];
  return service?.match(/^ {4}image: (\S+)$/mu)?.[1];
}

describe("the instance's Postgres image", () => {
  it("is pinned by digest in our own registry", () => {
    expect(pinned).toMatch(/^ghcr\.io\/work-shape\/catalyst-postgres@sha256:[0-9a-f]{64}$/u);
  });

  it.each(["clients/demo/docker-compose.yml", "clients/demo/docker-compose.prod.yml"])(
    "is the image %s starts",
    (composeFile) => {
      expect(postgresImageOf(composeFile)).toBe(pinned);
    }
  );
});
