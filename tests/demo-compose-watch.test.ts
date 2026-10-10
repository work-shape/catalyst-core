import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(resolve(root, "clients/demo/docker-compose.yml"), "utf8");
const packageManifestSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional()
});

function serviceBlock(service: string): string {
  const block = compose.split(`\n  ${service}:\n`)[1]?.split(/\n  [\w-]+:|\n\S/u)[0];
  expect(block, `Missing Compose service: ${service}`).toBeDefined();
  return block ?? "";
}

describe("demo Compose watch", () => {
  it("syncs every workspace package in the frontend dependency closure", () => {
    const packages = new Map(
      readdirSync(resolve(root, "packages")).map(
        (
          directory
        ): [string, { directory: string; manifest: z.infer<typeof packageManifestSchema> }] => {
          const manifest = packageManifestSchema.parse(
            JSON.parse(readFileSync(resolve(root, "packages", directory, "package.json"), "utf8"))
          );
          return [manifest.name, { directory, manifest }];
        }
      )
    );
    // Demo's browser entry, widgets and Vite plugin use chat-ui and ui;
    // api-client is also an explicit root for the shared frontend stack.
    const pending = ["@vivd-catalyst/chat-ui", "@vivd-catalyst/ui", "@vivd-catalyst/api-client"];
    const visited = new Set<string>();
    const syncEntries = Array.from(
      serviceBlock("ui").matchAll(/- action: sync\n\s+path: (\S+)\n\s+target: (\S+)/gu),
      (match) => [match[1], match[2]]
    );

    for (const name of pending) {
      if (visited.has(name)) continue;
      visited.add(name);
      const workspacePackage = packages.get(name);
      if (!workspacePackage) throw new Error(`Missing workspace package: ${name}`);
      const { directory, manifest } = workspacePackage;
      expect(syncEntries, `Missing source sync for ${name}`).toContainEqual([
        `../../packages/${directory}/src`,
        `/app/packages/${directory}/src`
      ]);
      for (const [dependency, version] of Object.entries({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies
      })) {
        if (version.startsWith("workspace:")) pending.push(dependency);
      }
    }
  });

  it.each(["ui", "api", "artifact-preview-worker"])(
    "%s rebuilds for package manifests and the lockfile",
    (service) => {
      const block = serviceBlock(service);
      expect(block).toContain(
        '- action: rebuild\n          path: ../../packages\n          include: "**/package.json"'
      );
      for (const path of ["../../package.json", "../../pnpm-lock.yaml"]) {
        expect(block).toContain(`- action: rebuild\n          path: ${path}`);
      }
      expect(block).toMatch(
        /- action: rebuild\n\s+path: \.\.\/\.\.\/clients\/demo(?:\/package\.json)?\n/u
      );
    }
  );
});
