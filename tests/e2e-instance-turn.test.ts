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

test("a healthy queue can exceed five minutes across successive holders", async () => {
  const { baseURL, lock, holder } = instance();
  const release = await takeTurn("access", baseURL);
  const started = Date.now();
  let now = started;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let acquired = false;
  const waiting = takeTurn("access", baseURL).then((done) => {
    acquired = true;
    return done;
  });
  try {
    // Each holder is healthy for 170 s, while this waiter loses three turns. Update both
    // the directory's acquisition time and the diagnostics just as a new holder does.
    for (let turn = 0; turn < 3; turn++) {
      const acquiredAt = new Date(started + turn * 170_000);
      await utimes(lock, acquiredAt, acquiredAt);
      await writeFile(holder, JSON.stringify({ pid: process.pid, startedAt: acquiredAt }));
      now = acquiredAt.getTime() + 170_000;
      await new Promise((done) => setTimeout(done, 300));
      expect(acquired).toBe(false);
    }
    expect(now - started).toBe(510_000);
  } finally {
    await release();
    await (
      await waiting
    )();
  }
});

test("an abandoned directory that cannot be reclaimed fails with holder diagnostics", async () => {
  const { baseURL, lock, holder } = instance();
  const release = await takeTurn("access", baseURL);
  await writeFile(join(lock, "jammed"), "");
  const abandonedAt = new Date(Date.now() - 180_001);
  await utimes(lock, abandonedAt, abandonedAt);
  try {
    await expect(takeTurn("access", baseURL)).rejects.toThrow(
      new RegExp(`holder older than 180000 ms: .*Holder: .*"title":"${info.title}"`, "u")
    );
    expect(await readFile(holder, "utf8")).toContain(info.file);
  } finally {
    await rm(join(lock, "jammed"));
    await release();
  }
});

test("an abandoned turn is reclaimed at the unchanged three-minute age", async () => {
  const { baseURL, lock } = instance();
  await mkdir(lock);
  const abandonedAt = new Date(Date.now() - 180_001);
  await utimes(lock, abandonedAt, abandonedAt);
  await (
    await takeTurn("access", baseURL)
  )();
});
