import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { takeTurn } from "../e2e/test";

const info = vi.hoisted(() => ({
  config: { workers: 16 },
  workerIndex: 7,
  project: { name: "lock-probe" },
  file: "e2e/holder.spec.ts",
  title: "the test holding the turn"
}));

vi.mock("@playwright/test", () => ({
  expect: vi.fn(),
  test: { info: () => info, extend: vi.fn() }
}));

const paths: string[] = [];

function instance() {
  const baseURL = `http://lock-probe-${randomUUID()}`;
  const lock = join(tmpdir(), `catalyst-e2e-access-${baseURL.replace(/\W+/gu, "-")}`);
  const holder = `${lock}.holder.json`;
  paths.push(lock, holder);
  return { baseURL, lock, holder };
}

afterEach(async () => {
  vi.restoreAllMocks();
  info.config.workers = 16;
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a turn records its holder and releases both the lock and its diagnostics", async () => {
  const { baseURL, lock, holder } = instance();
  const release = await takeTurn("access", baseURL);
  expect(JSON.parse(await readFile(holder, "utf8"))).toMatchObject({
    pid: process.pid,
    worker: 7,
    project: "lock-probe",
    file: "e2e/holder.spec.ts",
    title: info.title
  });
  await release();
  await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(holder)).rejects.toMatchObject({ code: "ENOENT" });
  await (
    await takeTurn("access", baseURL)
  )();
});

test.each([
  { workers: 1, budget: 180_000 },
  { workers: 16, budget: 300_000 }
])(
  "a jammed queue with $workers workers fails after $budget ms and names its holder",
  async ({ workers, budget }) => {
    const { baseURL, lock } = instance();
    const release = await takeTurn("access", baseURL);
    // Even an abandoned directory that cannot be removed must respect the queue deadline.
    await writeFile(join(lock, "jammed"), "");
    info.config.workers = workers;
    const started = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(started)
      .mockReturnValue(started + budget + 1);
    try {
      await expect(takeTurn("access", baseURL)).rejects.toThrow(
        new RegExp(`after ${budget} ms: .*Holder: .*"title":"${info.title}"`, "u")
      );
      expect(await readFile(`${lock}.holder.json`, "utf8")).toContain(info.file);
    } finally {
      await rm(join(lock, "jammed"));
      await release();
    }
  }
);

test("an abandoned turn is reclaimed at the unchanged three-minute age", async () => {
  const { baseURL, lock } = instance();
  await mkdir(lock);
  const abandonedAt = new Date(Date.now() - 180_001);
  await utimes(lock, abandonedAt, abandonedAt);
  await (
    await takeTurn("access", baseURL)
  )();
});
