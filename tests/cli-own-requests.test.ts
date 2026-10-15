import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter
} from "@vivd-catalyst/auth";
import { approvalRequestViewSchema, operationRunSchema } from "@vivd-catalyst/api-contract";
import { createGuardrailAssetKind } from "@vivd-catalyst/chat-server";
import { runCli } from "@work-shape/catalyst-cli";
import { testOperations } from "./support/operations";
import {
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance
} from "./support/access-instance";
import { inDays } from "./support/personal-api-keys";
import { callTestPath, createTestFetch, getTestJobs } from "./support/test-instance";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function fixture() {
  const t = await setupAccessInstance({
    modules: { personalApiKeys: { enabled: true } },
    furtherKinds: [createGuardrailAssetKind()],
    operations: {
      centralPolicySettings: () => [{ operation: "assets.publish", value: "approval" }]
    },
    server: (stores) => {
      const keys = {
        secret: "a-cli-parity-test-signing-secret-with-enough-length",
        clientInstanceId,
        apiAccessStore: stores.apiAccess,
        personalApiKeys: { store: stores.personalApiKeys, users: stores.users }
      };
      return {
        authAdapter: new CompositeAuthAdapter([
          new HmacServiceAccessTokenAuthAdapter(keys),
          recordAuthAdapter()
        ]),
        serviceAccessToken: { exchange: new ApiKeyAccessTokenExchange(keys) }
      };
    }
  });
  cleanup.push(() => t.instance.close());
  const cwd = await mkdtemp(join(tmpdir(), "cli-own-requests-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await t.expectOk(t.admin.id, "assets.put", {
    params: { kind: "guardrail", name: "review" },
    payload: {
      config: {
        name: "review",
        displayName: "Review",
        on: "asset.before_write",
        filter: { kind: "skill" },
        check: { kind: "pattern", pattern: "review", reason: "Review this." },
        outcome: "warn"
      }
    }
  });
  const instanceFetch = createTestFetch(t.instance);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    // createTestFetch matches :requestId before the static /mine route. Use the actual
    // HTTP route here so the CLI's paging is exercised without changing that helper.
    if (
      request.method === "GET" &&
      url.pathname === testOperations["approval_requests.list_mine"].path
    ) {
      const response = await callTestPath(
        t.instance,
        "GET",
        `${url.pathname}${url.search}`,
        Object.fromEntries(request.headers)
      );
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" }
      });
    }
    return instanceFetch(request);
  };
  async function key(scopes: string[], userId = t.admin.id) {
    const issued = await t.expectOk(userId, "me.api_keys.create", {
      payload: { name: "CLI", scopes, expiresAt: inDays(30) }
    });
    const { secret } = z.object({ secret: z.string() }).parse(issued.json());
    const exchanged = await t.instance.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(exchanged.statusCode).toBe(200);
    const { accessToken } = z.object({ accessToken: z.string() }).parse(exchanged.json());
    const headers = { authorization: `Bearer ${accessToken}` };
    return {
      headers,
      async cli(...args: string[]) {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli([...args, "--instance", "https://catalyst.test"], {
          cwd,
          env: { CATALYST_API_KEY: secret },
          fetchImpl,
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text)
        });
        return { code, out: out.join(""), err: err.join("") };
      }
    };
  }
  async function held(userId = t.admin.id) {
    const response = await t.call(userId, "assets.publish", {
      params: { kind: "guardrail", name: "review" },
      payload: { revision: 1 }
    });
    expect(response.statusCode, response.body).toBe(202);
    return operationRunSchema.parse(response.json());
  }
  return { ...t, cwd, key, held };
}

const mineSchema = z.object({ items: z.array(approvalRequestViewSchema) });

describe("personal keys following their calls and requests", () => {
  it("follows a CLI publish held with exit 3 to its approved decision", async () => {
    const t = await fixture();
    const key = await t.key(["guardrail.read", "guardrail.write", "guardrail.publish"]);
    const published = await key.cli("guardrail", "publish", "review", "--revision", "1", "--json");
    expect(published.code, published.err).toBe(3);
    const { run } = z.object({ run: operationRunSchema }).parse(JSON.parse(published.out));
    const pending = await key.cli("operation", "show", run.id, "--json");
    expect(pending.code, pending.err).toBe(3);
    expect(operationRunSchema.parse(JSON.parse(pending.out)).status).toBe("pending_approval");
    const requests = await key.cli("requests", "--json");
    expect(requests.code, requests.err).toBe(0);
    const [request] = z.array(approvalRequestViewSchema).parse(JSON.parse(requests.out));
    if (!request) throw new Error("Publish must file a request");
    expect(request).toMatchObject({ status: "pending", canDecide: false, canWithdraw: true });
    await t.expectOk(t.root.id, "approval_requests.decide", {
      params: { requestId: request.id },
      payload: { decision: "approve", comment: "Approved for publication" }
    });
    await getTestJobs(t.instance).runDue();
    const finished = await key.cli("operation", "show", run.id);
    expect(finished.code, finished.err).toBe(0);
    expect(finished.out).toContain("done");
    expect(finished.out).toContain("Decision: approved");
    expect(finished.out).toContain("Approved for publication");
    expect((await key.cli("requests")).out).toContain("approved");
  });

  it("reads the owner's browser call with a read-only key and hides another person's run", async () => {
    const t = await fixture();
    const own = await t.held();
    const other = await t.held(t.root.id);
    const key = await t.key(["guardrail.read"]);
    expect((await key.cli("operation", "show", own.id)).code).toBe(3);
    const response = await t.instance.call("operations.get_run", {
      params: { runId: other.id },
      headers: key.headers
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Operation run not found" }
    });
    expect(response.json<{ error: { details?: unknown } }>().error.details).toBeUndefined();
    expect(response.body).not.toContain(t.root.id);
    expect((await key.cli("operation", "show", other.id)).code).toBe(1);
    // Account scope on a session or a service credential gains no reach from the key exception.
    for (const headers of [
      { "x-test-user": t.admin.id, "x-test-scopes": "me:read" },
      { "x-test-service": "sp_parity", "x-test-scopes": "me:read" }
    ]) {
      expect(
        (await t.instance.call("operations.get_run", { params: { runId: own.id }, headers }))
          .statusCode
      ).toBe(403);
    }
    expect(
      (await t.instance.call("operations.list_runs", { headers: key.headers })).statusCode
    ).toBe(403);
  });

  it("lists and counts only the owner's requests, even for an administrator's key", async () => {
    const t = await fixture();
    await t.held();
    await t.held(t.root.id);
    const key = await t.key(["guardrail.publish"]);
    const listed = await t.instance.call("approval_requests.list_mine", { headers: key.headers });
    expect(listed.statusCode).toBe(200);
    const { items } = mineSchema.parse(listed.json());
    expect(items).toHaveLength(1);
    expect(items[0]?.requestedBy.id).toBe(t.admin.id);
    expect(items[0]).toMatchObject({ canDecide: false, canRevert: false });
    const counted = await t.instance.call("approval_requests.count_pending", {
      headers: key.headers
    });
    expect(counted.statusCode).toBe(200);
    expect(counted.json()).toEqual({
      count: 0,
      decided: 0,
      canReview: false,
      mine: { pending: 1, total: 1 }
    });
    expect(
      (await t.instance.call("approval_requests.list", { headers: key.headers })).statusCode
    ).toBe(403);
    expect(
      (
        await t.instance.call("approval_requests.get", {
          params: { requestId: items[0]?.id ?? "" },
          headers: key.headers
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await t.instance.call("approval_requests.decide", {
          params: { requestId: items[0]?.id ?? "" },
          payload: { decision: "approve" },
          headers: key.headers
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await t.instance.call("approval_requests.revert", {
          params: { requestId: items[0]?.id ?? "" },
          headers: key.headers
        })
      ).statusCode
    ).toBe(403);
    expect((await t.instance.call("conversations.list", { headers: key.headers })).statusCode).toBe(
      403
    );
  });

  it("withdraws only the owner's request with a write scope, refusing read-only keys and other owners", async () => {
    const t = await fixture();
    const ownRun = await t.held();
    await t.held(t.root.id);
    const writer = await t.key(["guardrail.write"]);
    const reader = await t.key(["guardrail.read"]);
    const all = await t.expectOk(t.root.id, "approval_requests.list");
    const requests = mineSchema.parse(all.json()).items;
    const own = requests.find((request) => request.requestedBy.id === t.admin.id);
    const other = requests.find((request) => request.requestedBy.id === t.root.id);
    if (!own || !other) throw new Error("Both owners must have a held call");
    const readOnly = await reader.cli("requests", "--withdraw", own.id);
    expect(readOnly.code).toBe(1);
    expect(readOnly.err).toContain("Missing auth scope 'config_assets:write'");
    expect(readOnly.err).not.toContain("conversation:write");
    const browser = await t.instance.call("approval_requests.withdraw", {
      params: { requestId: own.id },
      headers: { "x-test-user": t.admin.id, "x-test-scopes": "config_assets:write" }
    });
    expect(browser.statusCode).toBe(403);
    expect(browser.json()).toMatchObject({
      error: { message: "Missing auth scope 'conversation:write'" }
    });
    const refused = await t.instance.call("approval_requests.withdraw", {
      params: { requestId: other.id },
      headers: writer.headers
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect((await writer.cli("requests", "--withdraw", other.id)).code).toBe(1);
    const listed = await writer.cli("requests", "--json");
    expect(listed.code, listed.err).toBe(0);
    expect(z.array(approvalRequestViewSchema).parse(JSON.parse(listed.out))[0]?.canWithdraw).toBe(
      true
    );
    const withdrawn = await writer.cli("requests", "--withdraw", own.id, "--json");
    expect(withdrawn.code, withdrawn.err).toBe(0);
    expect(JSON.parse(withdrawn.out)).toMatchObject({ id: own.id, status: "withdrawn" });
    expect((await writer.cli("operation", "show", ownRun.id)).code).toBe(1);
    expect(
      (
        await t.expectOk(t.root.id, "approval_requests.get", { params: { requestId: other.id } })
      ).json()
    ).toMatchObject({ status: "pending" });
    // The existing browser guard must also keep a reviewer from withdrawing another person's request.
    expect(
      (await t.call(t.admin.id, "approval_requests.withdraw", { params: { requestId: other.id } }))
        .statusCode
    ).toBe(403);
  });

  it.each([
    ["operation"],
    ["operation", "show"],
    ["operation", "show", "id", "extra"],
    ["requests", "id"],
    ["operation", "show", "id", "--withdraw", "request"],
    ["requests", "--withdraw", ""],
    ["requests", "--workspace", "workspace"]
  ])("rejects invalid command arguments without sending a request: %j", async (...args) => {
    let sent = false;
    const code = await runCli(args, {
      cwd: process.cwd(),
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      fetchImpl: async () => {
        sent = true;
        throw new Error("Unexpected request");
      }
    });
    expect(code).toBe(2);
    expect(sent).toBe(false);
  });
});
