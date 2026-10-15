import { createTestInstance, type TestInstance } from "./support/test-instance";

import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { apiErrorResponseSchema } from "@vivd-catalyst/api-contract";
import type { ChatServerOptions } from "@vivd-catalyst/chat-server";
import { platformModules } from "@vivd-catalyst/client-assembly";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  asUserId,
  authenticatedUserFromRecord,
  createModuleRegistry,
  type AuthenticatedUser,
  type Logger,
  type UserRecord
} from "@vivd-catalyst/core";
import { CaptureMailTransport, TemplateMailSender } from "@vivd-catalyst/mail";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { z } from "zod";
import { createMissingRuntime, createUnusedModelProvider } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";

// The seven changes of user administration are registered operations. These tests fail
// without that: the plain routes wrote no Operation Run, answered no run id, knew no
// Idempotency-Key, recorded no refusal and answered a deletion with the user or an empty 202.

const servers: TestInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const SEVEN = [
  "users.create",
  "users.update",
  "users.delete",
  "users.identities.upsert",
  "users.identities.delete",
  "users.password.reset",
  "users.invitation.send"
] as const;

describe("user administration: a password rests nowhere", () => {
  // Without `secret` and `inputWithoutSecrets` the run kept a SHA-256 over the password and
  // the user id, and the same key answered `{ ok: true }` again.
  it("keeps a reset password in no stored row and no log line, and does not reset twice", async () => {
    const fixture = await createFixture();
    const target = await fixture.addUser("Grace", { email: "grace@example.test" });
    const password = 'Corr"ect\\Horse-7781-battery-staple';
    const reset = (sent: string) =>
      fixture.server.call("users.password.reset", {
        params: { userId: target.id },
        headers: { ...as.superadmin, "idempotency-key": "reset-once" },
        payload: { password: sent }
      });

    const first = await reset(password);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect([...fixture.passwords.values()]).toEqual([password]);

    const rows = await storedRows();
    expect([...new Set(rows.map((row) => row.table))]).toEqual(
      expect.arrayContaining(["operation_runs", "audit_events", "product_users"])
    );
    const traces = secretTraces(password);
    expect(traces).toHaveLength(13);
    const holding = rows.filter((row) => traces.some((trace) => row.text.includes(trace)));
    expect(holding.map((row) => row.table)).toEqual([]);
    expect(traces.filter((trace) => fixture.logged.join("\n").includes(trace))).toEqual([]);
    // The rows were read: the run of the reset is among them, with the hash of the marked input.
    const [run] = await fixture.runs("users.password.reset");
    expect(run).toMatchObject({ status: "done", idempotencyKey: "reset-once" });
    expect(run?.inputHash).toBe(
      sha256(`{"password":"[password]","userId":${JSON.stringify(target.id)}}`)
    );
    expect(rows.some((row) => row.text.includes(run?.inputHash ?? "none"))).toBe(true);
    expect(run?.output).toBeUndefined();
    expect(run?.resultRef).toBeUndefined();
    expect(first.headers["operation-run-id"]).toBe(run?.id);

    // The same key again, with the same password or another: nothing is set and nothing shown.
    for (const sent of [password, "another-password-4471"]) {
      const again = await reset(sent);
      expect(again.statusCode).toBe(409);
      expect(errorOf(again)).toMatchObject({
        code: "OUTPUT_NOT_RETAINED",
        details: { operationRunId: run?.id }
      });
      // The secret was in what the call sent: nothing was shown once and nothing is to revoke.
      expect(errorOf(again).message).toBe(
        "The call was already carried out and its answer is not kept. To carry it out again, call with a new Idempotency-Key."
      );
      expect(again.payload).not.toContain(sent);
    }
    expect(fixture.passwordWrites).toBe(1);
    expect([...fixture.passwords.values()]).toEqual([password]);
    expect(await fixture.runs("users.password.reset")).toHaveLength(1);
  });

  // The other branch of the reset: the user has a password sign-in, so `setPassword` runs and
  // the row `user.password_reset` is written.
  it("keeps the new password of a user with a password sign-in in no row", async () => {
    const fixture = await createFixture();
    const target = await fixture.addUser("Grace", { email: "grace@example.test" });
    const reset = (key: string, sent: string) =>
      fixture.server.call("users.password.reset", {
        params: { userId: target.id },
        headers: { ...as.superadmin, "idempotency-key": key },
        payload: { password: sent }
      });
    // The first reset gives the user the sign-in, the second sets its password.
    expect((await reset("reset-first", "First-Password-7781-for-grace")).statusCode).toBe(200);
    const password = "Second-Password-5503-for-grace";
    expect((await reset("reset-second", password)).statusCode).toBe(200);
    expect([...fixture.passwords.values()]).toEqual([password]);

    const [first, second] = await fixture.runs("users.password.reset");
    const events = await fixture.audit();
    const rowsOf = (runId: string | undefined) =>
      events.filter((event) => event.metadata?.operationRunId === runId).map((event) => event.type);
    expect([first, second].map((run) => rowsOf(run?.id).includes("user.password_reset"))).toEqual([
      false,
      true
    ]);

    const rows = await storedRows();
    const traces = secretTraces(password);
    expect(traces).toHaveLength(13);
    expect(
      rows.filter((row) => traces.some((trace) => row.text.includes(trace))).map((row) => row.table)
    ).toEqual([]);
    expect(traces.filter((trace) => fixture.logged.join("\n").includes(trace))).toEqual([]);
    // The rows were read: the row of this branch is among them.
    expect(rows.some((row) => row.text.includes("user.password_reset"))).toBe(true);
    expect(second?.output).toBeUndefined();
  });

  it("keeps the first password of a new user in no row, and creates the user once", async () => {
    const fixture = await createFixture();
    const password = "First-Password-9920-for-ada";
    const create = () =>
      fixture.server.call("users.create", {
        headers: { ...as.superadmin, "idempotency-key": "create-ada" },
        payload: {
          displayLabel: "Ada",
          email: "ada@example.test",
          passwordSignIn: { password }
        }
      });
    const first = await create();
    expect(first.statusCode).toBe(200);
    expect(first.payload).not.toContain(password);
    expect([...fixture.passwords.values()]).toEqual([password]);

    const rows = await storedRows();
    const traces = secretTraces(password);
    expect(
      rows.filter((row) => traces.some((trace) => row.text.includes(trace))).map((row) => row.table)
    ).toEqual([]);
    expect(traces.filter((trace) => fixture.logged.join("\n").includes(trace))).toEqual([]);
    const [run] = await fixture.runs("users.create");
    expect(run?.output).toBeUndefined();

    const again = await create();
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe("OUTPUT_NOT_RETAINED");
    expect(await fixture.usersNamed("Ada")).toHaveLength(1);
    expect(fixture.passwordWrites).toBe(1);
  });

  it("answers a repeated creation without a password from the run, and creates once", async () => {
    const fixture = await createFixture();
    const create = () =>
      fixture.server.call("users.create", {
        headers: { ...as.superadmin, "idempotency-key": "create-lin" },
        payload: { displayLabel: "Lin", email: "lin@example.test" }
      });
    const first = await create();
    const again = await create();
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(await fixture.usersNamed("Lin")).toHaveLength(1);
    expect(await fixture.runs("users.create")).toHaveLength(1);
  });

  it("puts the invitation link into the mail and into no row, and mails once per key", async () => {
    const fixture = await createFixture();
    const target = await fixture.addUser("Grace", { email: "grace@example.test" });
    const invite = () =>
      fixture.server.call("users.invitation.send", {
        params: { userId: target.id },
        headers: { ...as.superadmin, "idempotency-key": "invite-once" }
      });
    expect((await invite()).statusCode).toBe(200);
    const [mail] = fixture.transport.list();
    const token = /#password-setup=([\w-]+)/u.exec(mail?.text ?? "")?.[1] ?? "";
    expect(token).toMatch(/^setup-token-/u);
    const rows = await storedRows();
    expect(rows.filter((row) => row.text.includes(token)).map((row) => row.table)).toEqual([]);
    expect(fixture.logged.join("\n")).not.toContain(token);

    const again = await invite();
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(fixture.transport.list()).toHaveLength(1);
  });
});

describe("user administration: every change is an Operation Run", () => {
  it("leaves one run per call, with the caller, the user and the rows of the run", async () => {
    const fixture = await createFixture();
    const call = fixture.server.call.bind(fixture.server);
    const created = await call("users.create", {
      headers: as.superadmin,
      payload: { displayLabel: "Grace", email: "grace@example.test" }
    });
    expect(created.statusCode).toBe(200);
    const userId = z.object({ id: z.string() }).parse(created.json()).id;
    const params = { userId };
    const identity = { authSource: "oidc", externalUserId: "grace-1" };
    const answers = {
      "users.update": await call("users.update", {
        params,
        headers: as.superadmin,
        payload: { displayLabel: "Grace H." }
      }),
      "users.identities.upsert": await call("users.identities.upsert", {
        params,
        headers: as.superadmin,
        payload: identity
      }),
      "users.identities.delete": await call("users.identities.delete", {
        params: { ...params, ...identity },
        headers: as.superadmin
      }),
      "users.password.reset": await call("users.password.reset", {
        params,
        headers: as.superadmin,
        payload: { password: "a-long-enough-password" }
      }),
      "users.invitation.send": await call("users.invitation.send", {
        params,
        headers: as.superadmin
      }),
      "users.delete": await call("users.delete", { params, headers: as.superadmin })
    };
    for (const [operation, answer] of Object.entries(answers)) {
      expect({ operation, status: answer.statusCode }).toEqual({ operation, status: 200 });
    }
    // The account had nothing to wait for, so its rows are gone when the call answers.
    expect(answers["users.delete"].json()).toEqual({ state: "deleted" });

    const events = await fixture.audit();
    for (const operation of SEVEN) {
      const runs = await fixture.runs(operation);
      expect({ operation, runs: runs.length }).toEqual({ operation, runs: 1 });
      const [run] = runs;
      expect(run).toMatchObject({
        status: "done",
        actor: { kind: "user", id: fixture.users.superadmin.id },
        decision: { mode: "direct" }
      });
      const ofRun = events.filter((event) => event.metadata?.operationRunId === run?.id);
      expect(ofRun.map((event) => `${event.type}:${event.status}`)).toEqual(
        expect.arrayContaining([
          "operation.authorization_checked:success",
          "operation.started:success",
          "operation.completed:success"
        ])
      );
      // The run's own rows name the user the call changed. A creation names no user yet.
      const subjects = ofRun
        .filter((event) => event.type.startsWith("operation."))
        .map((event) => event.subject);
      expect(new Set(subjects)).toEqual(
        new Set([operation === "users.create" ? "users.create" : userId])
      );
    }
    // What each change says about itself is still written, now with its run.
    const own = (type: string) => events.filter((event) => event.type === type);
    for (const type of [
      "user.created",
      "user.updated",
      "user.identity_upserted",
      "user.identity_deleted",
      "user.password_sign_in_created",
      "user.invitation_sent"
    ]) {
      expect({
        type,
        runs: own(type).map((event) => typeof event.metadata?.operationRunId)
      }).toEqual({ type, runs: ["string"] });
    }
    // The run's check replaced the rows that said a caller was let through.
    expect(events.filter((event) => /^governance\.user_.*_authorized$/u.test(event.type))).toEqual(
      []
    );
  });

  it("answers a deletion that a job finishes with the state deleting", async () => {
    const fixture = await createFixture();
    const target = await fixture.addUser("Grace", { email: "grace@example.test" });
    // The deletion was requested before: the account is closed and its job has the rest.
    await fixture.store.users.markUserDeletionRequested({
      clientInstanceId: fixture.clientInstanceId,
      userId: target.id
    });
    const answer = await fixture.server.call("users.delete", {
      params: { userId: target.id },
      headers: as.superadmin
    });
    expect(answer.statusCode).toBe(200);
    expect(["deleting", "deleted"]).toContain(
      z.object({ state: z.string() }).parse(answer.json()).state
    );
  });
});

describe("user administration: who may change a user", () => {
  it("refuses a caller without users.manage on all seven, with one row for the check", async () => {
    const fixture = await createFixture();
    const target = await fixture.addUser("Grace", { email: "grace@example.test" });
    const before = untouched(await storedRows());
    for (const operation of SEVEN) {
      const refused = await fixture.server.call(
        operation,
        requestFor(operation, target.id, as.user)
      );
      expect({ operation, status: refused.statusCode }).toEqual({ operation, status: 403 });
      expect(errorOf(refused)).toMatchObject({
        code: "FORBIDDEN",
        details: { action: "users.manage" }
      });
      const [run] = await fixture.runs(operation);
      expect(run).toMatchObject({ status: "denied", actor: { id: fixture.users.user.id } });
      expect(refused.headers["operation-run-id"]).toBe(run?.id);
      expect(await fixture.rowsOfRun(run?.id)).toEqual([
        "operation.authorization_checked:denied",
        "operation.denied:denied"
      ]);
    }
    expect(untouched(await storedRows())).toEqual(before);
    expect(fixture.passwordWrites).toBe(0);
    expect(fixture.transport.list()).toEqual([]);
  });

  it("refuses an admin every change of a superadmin and every deletion", async () => {
    const fixture = await createFixture();
    const before = untouched(await storedRows());
    const superadminId = fixture.users.other.id;
    for (const operation of SEVEN.filter((name) => name !== "users.create")) {
      const refused = await fixture.server.call(
        operation,
        requestFor(operation, superadminId, as.admin)
      );
      expect({ operation, status: refused.statusCode }).toEqual({ operation, status: 403 });
      // No right a caller can be granted opens the rule, so the refusal names the operation.
      expect(errorOf(refused)).toMatchObject({
        code: "FORBIDDEN",
        message:
          operation === "users.delete"
            ? "Only a superadmin may delete a user"
            : "Only a superadmin may change a superadmin",
        details: { action: operation, reason: "no_grant" }
      });
      const [run] = await fixture.runs(operation);
      expect(run?.error?.message).toBe(errorOf(refused).message);
      expect(await fixture.rowsOfRun(run?.id)).toEqual([
        "operation.authorization_checked:denied",
        "operation.denied:denied"
      ]);
    }
    // An admin deletes nobody, a superadmin or not.
    const member = await fixture.addUser("Grace", {});
    const deletion = await fixture.server.call("users.delete", {
      params: { userId: member.id },
      headers: as.admin
    });
    expect(deletion.statusCode).toBe(403);
    expect(errorOf(deletion).details).toMatchObject({ action: "users.delete" });
    // Nothing but the new member was written, and the member is still there.
    const after = untouched(await storedRows());
    expect(after.filter((row) => !row.text.includes(member.id))).toEqual(before);
    expect(await fixture.user(member.id)).toMatchObject({ status: "active" });
    expect(fixture.passwordWrites).toBe(0);
  });

  it.each([
    ["the superadmin role", { roles: ["user", "superadmin"] }, "assign the superadmin role"],
    [
      "the right to manage API access",
      { permissions: ["api_access.manage"] },
      "give or take the right 'api_access.manage'"
    ],
    [
      "the right to manage agent models",
      { permissions: ["agent_models.manage"] },
      "give or take the right 'agent_models.manage'"
    ],
    [
      "a revocation of the right to manage API access",
      { permissions: ["!api_access.manage"] },
      "give or take the right 'api_access.manage'"
    ]
  ])(
    "refuses an admin who gives %s, on a new user and on an existing one",
    async (_label, change, rule) => {
      const fixture = await createFixture();
      const member = await fixture.addUser("Grace", {});
      const created = await fixture.server.call("users.create", {
        headers: as.admin,
        payload: { displayLabel: "New", ...change }
      });
      const updated = await fixture.server.call("users.update", {
        params: { userId: member.id },
        headers: as.admin,
        payload: change
      });
      for (const [operation, refused] of [
        ["users.create", created],
        ["users.update", updated]
      ] as const) {
        expect({ operation, status: refused.statusCode }).toEqual({ operation, status: 403 });
        expect(errorOf(refused).details).toMatchObject({ action: operation, reason: "no_grant" });
        expect(errorOf(refused).message).toBe(`Only a superadmin may ${rule}`);
      }
      expect(await fixture.usersNamed("New")).toEqual([]);
      expect(await fixture.user(member.id)).toMatchObject({ roles: ["user"], permissions: [] });
      // A superadmin makes the same change.
      const allowed = await fixture.server.call("users.update", {
        params: { userId: member.id },
        headers: as.superadmin,
        payload: change
      });
      expect(allowed.statusCode).toBe(200);
    }
  );

  it("lets an admin create and change a user who is no superadmin", async () => {
    const fixture = await createFixture();
    const created = await fixture.server.call("users.create", {
      headers: as.admin,
      payload: { displayLabel: "Grace", roles: ["user", "admin"], permissions: ["audit.view"] }
    });
    expect(created.statusCode).toBe(200);
    const userId = z.object({ id: z.string() }).parse(created.json()).id;
    const updated = await fixture.server.call("users.update", {
      params: { userId },
      headers: as.admin,
      payload: { status: "disabled" }
    });
    expect(updated.statusCode).toBe(200);
    expect(await fixture.user(userId)).toMatchObject({ status: "disabled" });
  });

  it("keeps the rules a superadmin is refused by: self, inactive caller, release rights", async () => {
    const fixture = await createFixture();
    const self = await fixture.server.call("users.delete", {
      params: { userId: fixture.users.superadmin.id },
      headers: as.superadmin
    });
    expect(self.statusCode).toBe(422);
    expect(errorOf(self).message).toBe("Superadmins cannot delete their own user account");

    const release = await fixture.server.call("users.create", {
      headers: as.superadmin,
      payload: { displayLabel: "Release", permissions: ["config_assets.release"] }
    });
    expect(release.statusCode).toBe(422);
    expect(errorOf(release).message).toBe(
      "Release permission can only be carried by service tokens"
    );

    const missing = await fixture.server.call("users.update", {
      params: { userId: "usr_missing" },
      headers: as.superadmin,
      payload: { displayLabel: "Nobody" }
    });
    expect(missing.statusCode).toBe(404);

    // The caller is disabled after admission, before the transaction that re-checks and
    // marks. The fresh check refuses the caller, preserving the last active superadmin.
    fixture.beforeNextTransaction(async () => {
      await fixture.store.users.updateUser({
        clientInstanceId: fixture.clientInstanceId,
        userId: asUserId(fixture.users.superadmin.id),
        status: "disabled"
      });
    });
    const last = await fixture.server.call("users.delete", {
      params: { userId: fixture.users.other.id },
      headers: as.superadmin
    });
    expect(last.statusCode).toBe(403);
    expect(errorOf(last).code).toBe("FORBIDDEN");
    expect(await fixture.user(fixture.users.other.id)).toMatchObject({ status: "active" });
    // Both refusals are the operation's own answer, so each run failed and names the code.
    expect((await fixture.runs("users.delete")).map((run) => run.error?.code)).toEqual([
      "VALIDATION_FAILED",
      "FORBIDDEN"
    ]);
  });

  it("keeps the last active superadmin when the signed-in caller's stored account disappeared", async () => {
    const fixture = await createFixture();
    // The store also admits identities vouched for by sign-in without a stored holder.
    // Such a caller is not evidence of another active superadmin in the instance.
    fixture.beforeNextTransaction(async () => {
      await fixture.store.workspaces.deletePersonalWorkspaceForUser({
        clientInstanceId: fixture.clientInstanceId,
        userId: asUserId(fixture.users.superadmin.id)
      });
      await fixture.store.users.deleteUser({
        clientInstanceId: fixture.clientInstanceId,
        userId: asUserId(fixture.users.superadmin.id)
      });
    });
    const last = await fixture.server.call("users.delete", {
      params: { userId: fixture.users.other.id },
      headers: as.superadmin
    });
    expect(last.statusCode).toBe(422);
    expect(errorOf(last).message).toBe("At least one active superadmin must remain");
    expect(await fixture.user(fixture.users.other.id)).toMatchObject({ status: "active" });
  });
});

const as = {
  superadmin: { authorization: "Bearer superadmin" },
  admin: { authorization: "Bearer admin" },
  user: { authorization: "Bearer user" }
};

/** A valid call of one of the seven on one user, as the caller the headers name. */
function requestFor(
  operation: (typeof SEVEN)[number],
  userId: string,
  headers: { authorization: string }
) {
  const params = { userId };
  switch (operation) {
    case "users.create":
      return { headers, payload: { displayLabel: "New" } };
    case "users.update":
      return { headers, params, payload: { displayLabel: "Changed" } };
    case "users.identities.upsert":
      return { headers, params, payload: { authSource: "oidc", externalUserId: "ext-1" } };
    case "users.identities.delete":
      return { headers, params: { ...params, authSource: "oidc", externalUserId: "ext-1" } };
    case "users.password.reset":
      return { headers, params, payload: { password: "a-long-enough-password" } };
    case "users.delete":
    case "users.invitation.send":
      return { headers, params };
  }
}

const errorOf = (response: { json(): unknown }) =>
  apiErrorResponseSchema.parse(response.json()).error;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * What a kept password could look like in a row or a log line: the password as it is, as JSON
 * writes it, a slice from its start and one from its middle, each also as base64 and
 * base64url, and its SHA-256. An encoding is cut to whole groups of three bytes, so it is
 * found whatever follows the value.
 */
function secretTraces(password: string): string[] {
  const values = [
    password,
    JSON.stringify(password).slice(1, -1),
    password.slice(0, 12),
    password.slice(8, 20)
  ];
  return [
    ...values.flatMap((value) => {
      const whole = Buffer.from(value.slice(0, value.length - (value.length % 3)));
      return [value, whole.toString("base64"), whole.toString("base64url")];
    }),
    sha256(password)
  ];
}

/** Every row of every table of this file's database, as the text Postgres holds. */
async function storedRows(): Promise<{ table: string; text: string }[]> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
  try {
    const tables = await sql<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`;
    const rows: { table: string; text: string }[] = [];
    for (const { schema, name } of tables) {
      const found = await sql.unsafe<{ text: string }[]>(
        `select row_to_json(t)::text as text from "${schema}"."${name}" t`
      );
      rows.push(...found.map(({ text }) => ({ table: name, text })));
    }
    return rows;
  } finally {
    await sql.end();
  }
}

/** The rows a refused call must leave as they were: all but the runs and the audit log. */
const untouched = (rows: { table: string; text: string }[]) =>
  rows
    .filter((row) => !["operation_runs", "audit_events"].includes(row.table))
    .sort((left, right) =>
      `${left.table}${left.text}`.localeCompare(`${right.table}${right.text}`)
    );

async function createFixture() {
  const clientInstanceId = asClientInstanceId("user-admin-operations-test");
  const store = (await createTestInstance()).stores;
  const record = (displayLabel: string, roles: UserRecord["roles"]) =>
    store.users.createUser({ clientInstanceId, displayLabel, roles });
  const records = {
    superadmin: await record("Superadmin", ["superadmin"]),
    other: await record("Other superadmin", ["superadmin"]),
    admin: await record("Admin", ["admin"]),
    user: await record("User", ["user"])
  };
  const signedIn = (user: UserRecord): AuthenticatedUser => ({
    ...authenticatedUserFromRecord({
      user,
      identity: { authSource: "test", externalUserId: user.id }
    }),
    scopes: ["*"]
  });
  const users = {
    superadmin: signedIn(records.superadmin),
    other: signedIn(records.other),
    admin: signedIn(records.admin),
    user: signedIn(records.user)
  };
  const config = createTestConfig();
  // Every line the server logs, at every level, with its fields.
  const logged: string[] = [];
  // The process logger writes of a request and its answer the method, the address and the
  // status, never a body (`serializeRequest` in client-assembly/src/logger.ts). The objects
  // themselves are left out here for the same reason, and every other field is kept whole.
  const withoutHttpObjects = (field: unknown): unknown =>
    typeof field === "object" && field !== null && ("req" in field || "res" in field)
      ? Object.fromEntries(Object.entries(field).filter(([key]) => key !== "req" && key !== "res"))
      : field;
  const keep =
    (level: string) =>
    (...line: unknown[]): void =>
      void logged.push(
        inspect([level, ...line.map(withoutHttpObjects)], { depth: null, maxStringLength: null })
      );
  const logger: Logger = {
    debug: keep("debug"),
    info: keep("info"),
    warn: keep("warn"),
    error: keep("error"),
    child: () => logger
  };
  const passwords = new Map<string, string>();
  const counts = { passwordWrites: 0, tokens: 0 };
  const standaloneAuth: NonNullable<ChatServerOptions["standaloneAuth"]> = {
    baseUrl: "http://127.0.0.1:4100/api/auth",
    handleRequest: () => Promise.resolve(new Response(null, { status: 404 })),
    routeKind: () => undefined,
    setPassword(command) {
      counts.passwordWrites += 1;
      passwords.set(command.externalUserId, command.password);
      return Promise.resolve();
    },
    setOrCreatePasswordSignIn(command) {
      counts.passwordWrites += 1;
      const externalUserId = `auth-${command.email}`;
      passwords.set(externalUserId, command.password);
      return Promise.resolve({
        externalUserId,
        displayLabel: command.displayLabel,
        email: command.email,
        emailVerified: true
      });
    },
    changePassword: () => Promise.resolve(),
    deletePasswordSignIn: () => Promise.resolve(),
    findPasswordSignIn: () => Promise.resolve(undefined),
    createPasswordSetupToken() {
      counts.tokens += 1;
      return Promise.resolve(`setup-token-${counts.tokens}-not-to-rest`);
    },
    completePasswordSetup() {
      throw new AppError("VALIDATION_FAILED", "This link is invalid or has expired");
    }
  };
  const transport = new CaptureMailTransport();
  // What runs before the next transaction, once: a change after operation admission.
  let raced: (() => Promise<void>) | undefined;
  const transaction = store.transaction.bind(store);
  store.transaction = async (fn) => {
    const run = raced;
    raced = undefined;
    await run?.();
    return transaction(fn);
  };
  const server = await createTestInstance({
    server: {
      config,
      logger,
      modules: createModuleRegistry(platformModules).snapshot({
        userInvitations: { enabled: true }
      }),
      clientInstanceId,
      authAdapter: {
        credentialMode: "explicit",
        id: "user-admin-operations-test",
        authenticate(request) {
          const authorization = request.headers.authorization;
          const value = Array.isArray(authorization) ? authorization[0] : authorization;
          const user = Object.entries(users).find(([key]) => value === `Bearer ${key}`)?.[1];
          if (!user) {
            throw new AppError("UNAUTHENTICATED", "Unknown test user");
          }
          return Promise.resolve({ ...user, correlationId: request.correlationId });
        }
      },
      stores: store,
      usageGovernance: new ModelUsageGovernance({
        store: store.usage,
        budget: config.usage.budget,
        safeguards: config.usage.safeguards,
        costs: config.usage.costs
      }),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit }),
      agentRuntime: createMissingRuntime(),
      modelProvider: createUnusedModelProvider(),
      standaloneAuth,
      mail: {
        sender: new TemplateMailSender(transport, {
          fromAddress: "noreply@mail.example.test",
          fromName: "Example Chat",
          productName: "Example"
        }),
        appUrl: "https://chat.example.test/"
      }
    }
  });
  servers.push(server);
  const audit = () => store.audit.listAuditEvents({ clientInstanceId, limit: 500 });
  const listUsers = () => store.users.listUsers({ clientInstanceId });
  return {
    clientInstanceId,
    server,
    store,
    users,
    logged,
    passwords,
    transport,
    audit,
    beforeNextTransaction(change: () => Promise<void>) {
      raced = change;
    },
    get passwordWrites() {
      return counts.passwordWrites;
    },
    addUser: (displayLabel: string, input: { email?: string }) =>
      store.users.createUser({ clientInstanceId, displayLabel, roles: ["user"], ...input }),
    user: async (userId: string) => (await listUsers()).find((user) => user.id === userId),
    usersNamed: async (displayLabel: string) =>
      (await listUsers()).filter((user) => user.displayLabel === displayLabel),
    runs: async (operation: string) =>
      (await store.operationRuns.list({ clientInstanceId }))
        .filter((run) => run.operation === operation)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    rowsOfRun: async (runId: string | undefined) =>
      (await audit())
        .filter((event) => event.metadata?.operationRunId === runId)
        .map((event) => `${event.type}:${event.status}`)
        .sort()
  };
}
