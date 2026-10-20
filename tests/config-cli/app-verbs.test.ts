import {
  getTestJobs,
  listenTestInstance,
  createTestFetch,
  type TestInstance
} from "../support/test-instance";
import { testOperations } from "../support/operations";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter
} from "@work-shape/catalyst-auth";
import { runCli } from "@work-shape/catalyst-cli";
import {
  clientInstanceId as accessInstanceId,
  recordAuthAdapter
} from "../support/access-instance";
import { guardedEvents } from "../support/guardrails";
import { appFiles, expectStatus, setupAppInstance } from "../support/app-instance";
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

  it("writes an App from its folder as a draft and publishes the revision it names", async () => {
    const t = await setupAppInstance({ explicitCredentials: true });
    try {
      const cwd = await createTemporaryDirectory();
      await mkdir(join(cwd, "offers"), { recursive: true });
      for (const file of appFiles("one")) {
        await writeFile(join(cwd, "offers", file.path), "text" in file ? file.text : "");
      }
      const { run } = cliAs(t.instance, t.admin.id, cwd);
      const workspace = ["--workspace", t.workspaceId];

      const kinds = await run("kinds");
      expect(kinds.out).toMatch(/^app +app +draft, then publish +folder \(app\.yaml\)/mu);
      // validate reads the folder that put takes, and says the instance checks it as it writes.
      const validated = await run("app", "validate", "--from", "offers", ...workspace);
      expect(validated, validated.err).toMatchObject({ code: 0 });
      expect(validated.out).toContain(
        `Read ${appFiles("one").length} files from '${join(cwd, "offers")}', within what one write carries.`
      );
      expect(validated.out).toContain("'catalyst app put <name> --from");
      const written = await run(
        "app",
        "put",
        "offers",
        "--from",
        "offers",
        "--if-revision",
        "new",
        ...workspace
      );
      expect(written, written.err).toMatchObject({
        code: 0,
        out: "Wrote app 'offers' at revision 1. It is a draft until it is published.\n"
      });
      expect(await t.listed("offers")).not.toHaveProperty("publishedRevision");

      // An App is published on a person's answer to the question, and on nothing else.
      const unasked = await run(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--revision",
        "1",
        ...workspace
      );
      expect(unasked.code).toBe(1);
      expect(unasked.err).toContain("add --yes to confirm it in your Inbox");
      const scripted = await cliAs(t.instance, t.admin.id, cwd, ["y"], true).run(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--revision",
        "1",
        "--yes",
        ...workspace
      );
      // `--yes` publishes nothing by itself: the publish waits in the caller's own Inbox.
      expect(scripted.code).toBe(3);
      expect(scripted.err).toContain("Waits in your Inbox for your confirmation");
      const declining = cliAs(t.instance, t.admin.id, cwd, ["n"]);
      const declined = await declining.run(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--revision",
        "1",
        ...workspace
      );
      expect(declined).toMatchObject({ code: 1, err: "Nothing was published.\n" });
      expect(declining.asked).toEqual([
        "Publish revision 1 of app 'offers'? If approval is required, this files a request in the Inbox. [y/N; d=Details] "
      ]);
      expect(await t.listed("offers")).not.toHaveProperty("publishedRevision");
      const published = await cliAs(t.instance, t.admin.id, cwd, ["y"]).run(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--revision",
        "1",
        ...workspace
      );
      expect(published, published.err).toMatchObject({ code: 0 });
      expect(published.out).toContain("Published revision 1 of App 'offers'.\n");
      expect(await t.listed("offers")).toMatchObject({ publishedRevision: 1 });
      const shown = await run("apps", "show", "offers", "--files", ...workspace);
      expect(shown.out).toContain("index.html");
    } finally {
      await t.close();
    }
  });

  it("an admin key's interactive CLI publish waits with its request id and Inbox instructions", async () => {
    const t = await setupAppInstance({
      modules: { personalApiKeys: { enabled: true } },
      server(stores) {
        const keys = {
          secret: "a-test-service-access-token-secret-with-enough-length",
          clientInstanceId: accessInstanceId,
          apiAccessStore: stores.apiAccess,
          personalApiKeys: { store: stores.personalApiKeys, users: stores.users }
        };
        return {
          authAdapter: new CompositeAuthAdapter([
            new HmacServiceAccessTokenAuthAdapter(keys),
            recordAuthAdapter()
          ]),
          serviceAccessToken: { exchange: new ApiKeyAccessTokenExchange(keys) },
          operations: { events: guardedEvents(stores, {}, { shipped: true }).events }
        };
      }
    });
    try {
      expectStatus(
        await t.putApp(t.admin.id, "cli-key-publish", appFiles("key", { id: "cli-key-publish" })),
        200
      );
      const payload = {
        name: "Publishing key",
        scopes: ["app.read", "app.publish"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      };
      // A key cannot acquire the right that approves a publish.
      expectStatus(
        await t.call(t.admin.id, "me.api_keys.create", {
          payload: { ...payload, scopes: [...payload.scopes, "app.approve"] }
        }),
        422
      );
      const issued = (await t.expectOk(t.admin.id, "me.api_keys.create", { payload })).json();
      const url = await listenTestInstance(t.instance);
      const err: string[] = [];
      const questions: string[] = [];
      const code = await runCli(
        [
          "app",
          "publish",
          "cli-key-publish",
          "--audience",
          "workspace",
          "--revision",
          "1",
          "--workspace",
          t.workspaceId,
          "--instance",
          url
        ],
        {
          env: { CATALYST_API_KEY: issued.secret },
          prompt(question) {
            questions.push(question);
            return Promise.resolve("yes");
          },
          stdout() {},
          stderr: (text) => err.push(text),
          fetchImpl(input, init) {
            const request = new Request(input, init);
            // Client assertions cannot change the authenticated origin into an app click.
            request.headers.set("x-catalyst-interactive", "true");
            request.headers.set("x-catalyst-origin", "user");
            return fetch(request);
          }
        }
      );
      expect(code, err.join("")).toBe(3);
      expect(questions).toHaveLength(1);
      const [request] = await t.stores.approvals.listApprovalRequests({
        clientInstanceId: accessInstanceId,
        kinds: ["app_publish"],
        status: "pending"
      });
      expect(request).toMatchObject({ requestedBy: { id: t.admin.id }, status: "pending" });
      if (!request) throw new Error("Missing publish request");
      expect(request.payload).toMatchObject({ origin: { kind: "cli" } });
      expect(err.join("")).toContain(`request ${request.id}`);
      expect(err.join("")).toContain("you can approve it in the Inbox");
      expect((await t.listed("cli-key-publish")).publishedRevision).toBeUndefined();
      await t.expectOk(t.admin.id, "approval_requests.decide", {
        params: { requestId: request.id },
        payload: { decision: "approve" }
      });
      await getTestJobs(t.instance).runDue();
      expect((await t.listed("cli-key-publish")).publishedRevision).toBe(1);
    } finally {
      await t.close();
    }
  });

  // GR-PUB-1, check 66: a member who may publish and not approve answers the question, and the
  // CLI ends with the request an approver decides. Nothing is live until then.
  it("ends a member's publish of an App with the request an approver decides", async () => {
    const t = await setupAppInstance({
      explicitCredentials: true,
      server: (stores) => ({
        operations: { events: guardedEvents(stores, {}, { shipped: true }).events }
      })
    });
    try {
      for (const action of ["app.read", "app.write", "app.publish"]) {
        await t.stores.access.createGrant({
          clientInstanceId: accessInstanceId,
          holderKind: "user",
          holderId: t.kai.id,
          action,
          effect: "allow",
          scopeKind: "workspace",
          scopeId: t.workspaceId,
          grantedBy: t.admin.id
        });
      }
      await t.putApp(t.admin.id, "offers", appFiles("one"));
      const cwd = await createTemporaryDirectory();

      const held = await cliAs(t.instance, t.kai.id, cwd, ["yes"]).run(
        "app",
        "publish",
        "offers",
        "--audience",
        "workspace",
        "--revision",
        "1",
        "--workspace",
        t.workspaceId
      );

      expect(held.code, held.err).toBe(3);
      const [request] = await t.stores.approvals.listApprovalRequests({
        clientInstanceId: accessInstanceId,
        kinds: ["app_publish"],
        status: "pending"
      });
      expect(held.err).toContain(`request ${request?.id ?? "none"}`);
      expect(await t.listed("offers")).not.toHaveProperty("publishedRevision");
    } finally {
      await t.close();
    }
  });
});
