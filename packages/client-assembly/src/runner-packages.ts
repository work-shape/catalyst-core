import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { runnerPackageKey, type WorkflowRunnerPackage } from "@work-shape/catalyst-workflows";

/** The image build copies the runner's manifest into every publishing API image. */
export const RUNNER_PACKAGE_MANIFEST_PATH = "/usr/local/share/catalyst/runner-packages.json";
// Protect startup's JSON parser from a broken image asset; it imposes no declaration count cap.
const RUNNER_PACKAGE_MANIFEST_MAX_BYTES = 1024 * 1024;
const manifestSchema = z.array(
  z.strictObject({
    name: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.!+_-]*$/u)
  })
);

export interface RunnerPackageManifest {
  readonly packages: readonly WorkflowRunnerPackage[];
  readonly unavailable?: "missing" | "invalid";
}

/** Missing, unreadable and malformed manifests all fail closed, without stopping startup. */
export function readRunnerPackageManifest(
  path = RUNNER_PACKAGE_MANIFEST_PATH
): RunnerPackageManifest {
  try {
    if (statSync(path).size > RUNNER_PACKAGE_MANIFEST_MAX_BYTES)
      return { packages: [], unavailable: "invalid" };
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return { packages: [], unavailable: "invalid" };
    const names = new Set(parsed.data.map(({ name }) => runnerPackageKey(name)));
    if (names.size !== parsed.data.length) return { packages: [], unavailable: "invalid" };
    return { packages: parsed.data };
  } catch (error) {
    return {
      packages: [],
      unavailable: z.object({ code: z.literal("ENOENT") }).safeParse(error).success
        ? "missing"
        : "invalid"
    };
  }
}

// A release asset, read once at process startup. The publish gate and shipped skill share it.
export const runnerPackageManifest = readRunnerPackageManifest();
