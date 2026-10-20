import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeE2eConfig } from "../../scripts/e2e-config.mjs";

let written: string | undefined;

/**
 * The path of the browser suite's composed instance config (tests/fixtures/e2e-app.yaml with
 * every spec's people from tests/fixtures/e2e-users), written once per test process into a
 * directory of its own, so test files running side by side never read a half-written file.
 */
export function e2eConfigFile(): string {
  written ??= writeE2eConfig(
    join(mkdtempSync(join(tmpdir(), "catalyst-e2e-config-")), "e2e-app.yaml")
  );
  return written;
}
