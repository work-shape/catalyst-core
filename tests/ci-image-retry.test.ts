import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function probe(message: string, failures: number) {
  const root = await mkdtemp(join(tmpdir(), "image-retry-test-"));
  roots.push(root);
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin/sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    join(root, "scripts/check-image-build.sh"),
    `#!/bin/bash
count=$(cat count 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > count
if [ "$count" -le ${failures} ]; then
  echo '${message}'
  exit 7
fi
`
  );
  const result = promisify(execFile)(
    "bash",
    [resolve(".github/scripts/check-images-with-retry.sh")],
    { cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` } }
  );
  return { root, result, count: async () => Number(await readFile(join(root, "count"), "utf8")) };
}

it("recovers from a registry failure and preserves a successful result", async () => {
  const t = await probe("failed to resolve source metadata: registry timeout", 2);
  await t.result;
  expect(await t.count()).toBe(3);
});

it("fails immediately on an image contract violation", async () => {
  const t = await probe("API image must carry no git", 3);
  await expect(t.result).rejects.toMatchObject({ code: 7 });
  expect(await t.count()).toBe(1);
});

it("keeps the final registry failure red after the bounded retries", async () => {
  const t = await probe("unexpected status from HEAD request: 503 Service Unavailable", 3);
  await expect(t.result).rejects.toMatchObject({ code: 7 });
  expect(await t.count()).toBe(3);
});
