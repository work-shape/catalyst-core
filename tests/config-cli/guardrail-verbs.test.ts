import { createTestFetch, type TestInstance } from "../support/test-instance";
import { testOperations } from "../support/operations";
import { describe, expect, it } from "vitest";
import { createGuardrailAssetKind } from "@work-shape/catalyst-server";
import { runCli } from "@work-shape/catalyst-cli";
import {
  clientInstanceId as accessInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  skill as accessSkill
} from "../support/access-instance";
import { IBAN as GUARDRAIL_IBAN, guardedEvents, ibanPattern } from "../support/guardrails";
import { createTemporaryDirectory, jsonResponse } from "../support/config-cli";

describe("catalyst asset commands against an instance", () => {
  /**
   * The CLI as one user of the instance: the key exchange is answered here, and every other
   * call reaches the instance signed in as that user. Each request is recorded.
   */
  /** The CLI as `userId`. `answers` are typed at its questions, in order; without them nobody can be asked. */
  function cliAs(
    instance: TestInstance,
    userId: string,
    cwd: string,
    answers?: string[],
    /** Signs in through the user's personal key, as the CLI does, instead of their session. */
    personalKey = false
  ) {
    const serverFetch = createTestFetch(instance, {
      "x-test-user": userId,
      ...(personalKey ? { "x-test-key": "personal" } : {})
    });
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === testOperations["access_tokens.exchange"].path) {
        return jsonResponse(200, {
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      }
      return serverFetch(request);
    };
    const asked: string[] = [];
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli([...args, "--instance", "https://catalyst.test"], {
        cwd,
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        ...(answers
          ? {
              prompt: (question: string) => {
                asked.push(question);
                return Promise.resolve(answers.shift() ?? "");
              }
            }
          : {})
      });
      return { code, out: out.join(""), err: err.join("") };
    };
    return { run, requests, asked };
  }

  // Check 57, from the verification of PR 67. Fails without the fix: a guardrail on
  // `operation.before_call`, whose past calls cannot be checked again, reported "would have
  // blocked 0" and was published at once, though it blocked every one of those calls after.
  it("does not publish a first blocking guardrail unconfirmed when its dry run could check nothing", async () => {
    const t = await setupAccessInstance({
      furtherKinds: [createGuardrailAssetKind()],
      server: (stores) => ({
        authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" },
        operations: { events: guardedEvents(stores, {}).events }
      })
    });
    const cwd = await createTemporaryDirectory();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: accessSkill("faq", "Antworten.") }
    });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "guardrail", name: "no-puts" },
      payload: {
        config: {
          name: "no-puts",
          displayName: "No puts",
          on: "operation.before_call",
          filter: { operation: "assets.put" },
          check: { kind: "pattern", pattern: "." },
          outcome: "block"
        }
      }
    });
    const { run } = cliAs(t.instance, t.admin.id, cwd);
    const unconfirmed = await run("guardrail", "publish", "no-puts", "--revision", "1");
    expect(unconfirmed.err).toContain("would have blocked 0 actions by 0 people");
    expect(unconfirmed.code).toBe(1);
    const unchecked = /and (\d+) actions? it could not check/u.exec(unconfirmed.err)?.[1];
    expect(Number(unchecked)).toBeGreaterThan(0);
    // Nothing was published.
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId: accessInstanceId,
      kind: "guardrail",
      name: "no-puts"
    });
    expect(stored?.publishedRevision).toBeUndefined();
    const confirmed = await run(
      "guardrail",
      "publish",
      "no-puts",
      "--revision",
      "1",
      "--confirm",
      /--confirm (\d+)/u.exec(unconfirmed.err)?.[1] ?? ""
    );
    expect(confirmed.code, confirmed.err).toBe(0);
    const blocked = await t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: accessSkill("faq", "Wieder neu.") }
    });
    expect(blocked.statusCode).toBe(403);
  });

  // `catalyst guardrail test`, `dry-run`, `publish` and `unpublish` (EW-6a). Fails without the
  // change: the CLI had none of these, and a guardrail could not be published.
  it("tests a guardrail's draft, shows the dry run, publishes only on a confirmed number, and unpublishes", async () => {
    const t = await setupAccessInstance({
      furtherKinds: [createGuardrailAssetKind()],
      server: () => ({ authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" } })
    });
    const cwd = await createTemporaryDirectory();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: accessSkill("faq", `Konto ${GUARDRAIL_IBAN}`) }
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
    const { run } = cliAs(t.instance, t.admin.id, cwd);

    const sample = await run("guardrail", "test", "no-iban", "--text", `Konto ${GUARDRAIL_IBAN}`);
    expect(sample.code, sample.err).toBe(0);
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
        .getConfigAsset({ clientInstanceId: accessInstanceId, kind: "guardrail", name: "no-iban" })
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
