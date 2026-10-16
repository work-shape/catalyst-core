import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const version = "0.8.0-rc.1";
const script = new URL("notes.mjs", import.meta.url).pathname;
const limitBytes = 120_000;
const changelogLink = `https://github.com/work-shape/catalyst-core/blob/v${version}/CHANGELOG.md`;

function fixture(t, body) {
  const root = mkdtempSync(join(tmpdir(), "release-notes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\n## Unreleased\n\nnewer changes\n\n## ${version} — 2026-10-16\n\n${body}\n\n## 0.7.0 — 2026-10-01\n\nolder changes\n`
  );
  return root;
}
const notes = (root) => execFileSync(process.execPath, [script, version], { cwd: root });

test("short notes preserve the exact version section", (t) => {
  const body = "### Fixed\n\n- Fixed release retries.\n- Grüße 🚀";
  assert.equal(notes(fixture(t, body)).toString(), `${body}\n`);
});

for (const size of [limitBytes - 2, limitBytes - 1, limitBytes, limitBytes + 1, 250_000]) {
  test(`ASCII notes of ${size} bytes keep the complete output within ${limitBytes} bytes`, (t) => {
    const body = "a".repeat(size);
    const output = notes(fixture(t, body));
    assert.ok(output.length <= limitBytes);
    assert.ok(output.toString().length < 125_000);
    if (size + 1 <= limitBytes) assert.equal(output.toString(), `${body}\n`);
    else {
      assert.match(output.toString(), /Notes truncated/u);
      assert.ok(output.toString().includes(changelogLink));
      assert.ok(body.startsWith(output.toString().split("\n\n")[0]));
    }
  });
}

for (const character of ["ü", "漢", "🚀"]) {
  test(`truncation preserves UTF-8 when the boundary splits ${character}`, (t) => {
    const output = notes(fixture(t, character.repeat(limitBytes)));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
    assert.ok(output.length <= limitBytes);
    assert.ok(decoded.endsWith(`(${changelogLink}).\n`));
    assert.doesNotMatch(decoded, /�|older changes|newer changes/u);
  });
}

test("invalid versions and absent sections still fail closed", (t) => {
  const root = fixture(t, "changes");
  for (const [requested, message] of [
    ["bad", "Invalid release version"],
    ["9.0.0", "has no 9.0.0 section"]
  ]) {
    const result = spawnSync(process.execPath, [script, requested], {
      cwd: root,
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(message));
  }
});
