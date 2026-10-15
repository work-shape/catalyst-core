// Writes the platform commit the site was built from to dist/catalyst/commit.json, as
// {"commit": "<sha>"}, so a reader (the hand-over check) can tell which commit the published docs
// show. Every publish builds with this script, so the file cannot fall out of step with the site.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
writeFileSync(resolve(here, "../dist/catalyst/commit.json"), `${JSON.stringify({ commit })}\n`);
