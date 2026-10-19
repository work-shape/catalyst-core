import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import platformContext from "./fixtures/cli-platform-context.json";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const context = {
  ...platformContext,
  kinds: [
    {
      kind: "knowledge_base",
      plural: "knowledge_bases",
      lifecycle: "draft_published",
      representation: "config",
      owners: ["instance", "workspace"],
      actions: {
        read: "knowledge_base.read",
        write: "knowledge_base.write",
        delete: "knowledge_base.delete",
        publish: "knowledge_base.publish"
      }
    }
  ]
};

async function source() {
  const dir = await mkdtemp(join(tmpdir(), "scope-query-"));
  directories.push(dir);
  await mkdir(join(dir, "queries"));
  await writeFile(
    join(dir, "kb.yaml"),
    "name: scoped\nqueries:\n  - { name: findings, file: queries/findings.sql }\n"
  );
  return dir;
}
async function put(cwd: string) {
  let sent: unknown;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === apiOperations["access_tokens.exchange"].path)
      return Response.json({
        accessToken: randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString()
      });
    if (path === apiOperations["platform.context.get"].path) return Response.json(context);
    sent = await request.json();
    return Response.json({ version: 1, revision: 1, warnings: [] });
  };
  const code = await runCli(
    [
      "knowledge-base",
      "put",
      "scoped",
      "--from",
      "kb.yaml",
      "--if-revision",
      "new",
      "--instance",
      "https://catalyst.test"
    ],
    { cwd, fetchImpl, env: { CATALYST_API_KEY: randomUUID() }, stdout() {}, stderr() {} }
  );
  return { code, sent };
}

describe("named query SQL files", () => {
  it("puts the exact named SQL source into the versioned Knowledge Base definition", async () => {
    const cwd = await source();
    const sql =
      "-- @param note text optional\nselect * from findings where mandant_nr = any($viewer.scope('mandant'))";
    await writeFile(join(cwd, "queries/findings.sql"), sql);
    const result = await put(cwd);
    expect(result.code).toBe(0);
    expect(result.sent).toMatchObject({
      config: { queries: [{ name: "findings", file: "queries/findings.sql", sql }] }
    });
  });
  it("refuses a query file linked outside the Knowledge Base folder", async () => {
    const cwd = await source();
    const outside = await mkdtemp(join(tmpdir(), "scope-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "outside.sql"), "select * from findings");
    await symlink(join(outside, "outside.sql"), join(cwd, "queries/findings.sql"));
    expect(await put(cwd)).toEqual({ code: 1, sent: undefined });
  });
});
