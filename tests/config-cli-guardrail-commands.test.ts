import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuardrailAssetKind } from "@vivd-catalyst/chat-server";
import { runCli } from "../packages/config-cli/src/index";
import {
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  skill
} from "./support/access-instance";
import { IBAN, ibanPattern } from "./support/guardrails";
import { testOperations } from "./support/operations";
import { createTestFetch, type TestInstance } from "./support/test-instance";

// `catalyst guardrail test`, `dry-run`, `publish` and `unpublish` against an instance (EW-6a):
// a test answers what the draft would say, the publish shows the dry run first and a first
// publish that would block goes ahead only with `--confirm` naming the number. Fails without
// the change: the CLI had none of these, and a guardrail could not be published.

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function cliAs(instance: TestInstance, userId: string, cwd: string) {
  const serverFetch = createTestFetch(instance, { "x-test-user": userId });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === testOperations["access_tokens.exchange"].path) {
      return new Response(
        JSON.stringify({
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return serverFetch(request);
  };
  return async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...args, "--instance", "https://catalyst.test"], {
      cwd,
      env: { CATALYST_API_KEY: "cat_personal" },
      fetchImpl,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text)
    });
    return { code, out: out.join(""), err: err.join("") };
  };
}

describe("catalyst guardrail commands", () => {
  it("tests a draft, shows the dry run, publishes only on a confirmed number, and unpublishes", async () => {
    const t = await setupAccessInstance({
      furtherKinds: [createGuardrailAssetKind()],
      server: () => ({ authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" } })
    });
    const cwd = await mkdtemp(join(tmpdir(), "catalyst-guardrail-cli-"));
    directories.push(cwd);
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: skill("faq", `Konto ${IBAN}`) }
    });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "guardrail", name: "no-iban" },
      payload: {
        config: {
          name: "no-iban",
          displayName: "No IBAN",
          on: "asset.before_write",
          filter: { kind: "skill" },
          check: { kind: "pattern", pattern: ibanPattern, reason: "No bank account." },
          outcome: "block"
        }
      }
    });
    const run = cliAs(t.instance, t.admin.id, cwd);

    const sample = await run("guardrail", "test", "no-iban", "--text", `Konto ${IBAN}`);
    expect(sample, sample.err).toMatchObject({ code: 0 });
    expect(sample.out).toContain(
      "Revision 1 of guardrail 'no-iban' on 'asset.before_write': block (No bank account.)."
    );
    const onAsset = await run("guardrail", "test", "no-iban", "--asset", "skill:faq");
    expect(onAsset.out).toContain(": block (No bank account.).");

    const dryRun = await run("guardrail", "dry-run", "no-iban");
    expect(dryRun.code, dryRun.err).toBe(0);
    expect(dryRun.out).toContain("would have blocked 1 action by 1 person");
    expect(dryRun.out).not.toContain(t.admin.id);

    const unconfirmed = await run("guardrail", "publish", "no-iban", "--revision", "1");
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.err).toContain("would have blocked 1 action by 1 person");
    expect(unconfirmed.err).toContain("Publish it with --confirm 1");
    const wrong = await run("guardrail", "publish", "no-iban", "--revision", "1", "--confirm", "2");
    expect(wrong.code).toBe(1);
    const published = () =>
      t.stores.configAssets
        .getConfigAsset({ clientInstanceId, kind: "guardrail", name: "no-iban" })
        .then((asset) => asset?.publishedRevision);
    expect(await published()).toBeUndefined();

    const confirmed = await run(
      "guardrail",
      "publish",
      "no-iban",
      "--revision",
      "1",
      "--confirm",
      "1"
    );
    expect(confirmed.code, confirmed.err).toBe(0);
    expect(confirmed.out).toContain("Published revision 1 of guardrail 'no-iban'");
    expect(await published()).toBe(1);

    const unpublished = await run("guardrail", "unpublish", "no-iban");
    expect(unpublished.code, unpublished.err).toBe(0);
    expect(unpublished.out).toContain("Guardrail 'no-iban' no longer enforces");
    expect(await published()).toBeUndefined();

    // The commands are a guardrail's; another kind is told so before anything is sent.
    expect((await run("skill", "test", "faq", "--text", "x")).code).toBe(2);
    expect((await run("guardrail", "test", "no-iban")).code).toBe(2);
  });
});
