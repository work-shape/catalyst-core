import { test as base, expect } from "@playwright/test";
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { until } from "../scripts/agent-stories/processes.mjs";
import { evidence, hash, usageTotal } from "../scripts/agent-stories/safety.mjs";
import { createdOracle } from "../scripts/agent-stories/oracles.mjs";

// Fixture deletion is asynchronous; a bounded drain keeps warm reuse free of owned work.
const FIXTURE_CLEANUP_MS = 30_000;
const folder = process.env.AGENT_STORIES_OUTPUT;
const stack = JSON.parse(await readFile(process.env.AGENT_STORIES_STACK, "utf8"));
const auth = JSON.parse(await readFile(resolve(stack.privateDir, "stack-auth.json"), "utf8"));
export const api = stack.api,
  ui = stack.ui;
export const sql = postgres(auth.env.DATABASE_URL, { max: 2, connect_timeout: 5, onnotice() {} });
export const selected = (id) => process.env.AGENT_STORIES_CASES.split(",").includes(id);
export const terminal = (row) => ["completed", "failed", "cancelled"].includes(row?.status);
export async function json(request, method, path, body, allowed = [200, 201]) {
  const response = await request.fetch(`${api}${path}`, {
    method,
    data: body,
    headers: { Origin: ui },
    timeout: 30_000
  });
  if (!allowed.includes(response.status()))
    throw new Error(`Product API ${method} ${path.split("?")[0]}: HTTP ${response.status()}`);
  if (response.status() === 204) return null;
  const result = await response.json();
  if (result && result.status && result.output && Object.hasOwn(result.output, "value"))
    return result.output.value;
  return result;
}
export async function signIn(context, person) {
  await json(context.request, "POST", "/api/auth/sign-in/email", {
    email: person.email,
    password: person.password,
    rememberMe: true
  });
  return json(context.request, "GET", "/api/v1/me");
}
export async function session(browser, watch, person) {
  const context = await browser.newContext({ baseURL: ui });
  watch(context);
  const me = await signIn(context, person);
  const page = await context.newPage();
  return { context, page, me };
}
export const test = base.extend({
  story: async ({ browser }, use, testInfo) => {
    const id = testInfo.title;
    const errors = [];
    const contexts = [];
    const watch = (context) => {
      contexts.push(context);
      context.on("page", (page) => {
        page.on("pageerror", () => errors.push("pageerror"));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push("console.error");
        });
        page.on("response", (response) => {
          if (response.status() >= 400 && /\/api\/v1\//u.test(response.url()))
            errors.push("bridge/API failure");
        });
        page.on("requestfailed", (request) => {
          if (/\/api\/v1\/.*(?:storage|action)/u.test(request.url())) errors.push("bridge failed");
        });
      });
    };
    const startedAt = new Date().toISOString(),
      deadline = Date.now() + testInfo.timeout;
    const baseline = new Set((await sql`select id from model_usage_events`).map((row) => row.id));
    const root = await browser.newContext({ baseURL: ui });
    const people = [];
    let workspace, actor;
    try {
      await signIn(root, { email: "setup@example.test", password: auth.secrets.password });
      for (const suffix of ["builder", "teammate"]) {
        const person = {
          email: `${suffix}-${randomUUID()}@example.test`,
          password: randomUUID() + randomUUID()
        };
        const user = await json(root.request, "POST", "/api/v1/instance/users", {
          email: person.email,
          displayLabel: `Synthetic ${suffix}`,
          roles: ["user"],
          permissions: [],
          permissionRefs: ["demo-tools"],
          status: "active",
          passwordSignIn: { password: person.password }
        });
        people.push({ ...person, id: user.id });
      }
      actor = await session(browser, watch, people[0]);
      workspace = await json(actor.context.request, "POST", "/api/v1/workspaces", {
        name: `Story ${id} ${randomUUID()}`,
        defaultConversationVisibility: "private"
      });
      await json(actor.context.request, "POST", `/api/v1/workspaces/${workspace.id}/members`, {
        email: people[1].email
      });
      for (const action of [
        "app.read",
        "app.write",
        "app.publish",
        "skill.read",
        "skill.write",
        "agent.read"
      ])
        await json(root.request, "POST", "/api/v1/instance/access/grants", {
          holderKind: "user",
          holderId: actor.me.id,
          action,
          effect: "allow",
          scopeKind: "workspace",
          scopeId: workspace.id
        });
      for (const action of ["workflow.read", "workflow.write", "workflow.use"])
        await json(root.request, "POST", "/api/v1/instance/access/grants", {
          holderKind: "user",
          holderId: actor.me.id,
          action,
          effect: "allow",
          scopeKind: "instance"
        });
      // The shipped shared Workflow account holds these read-only sample Connections.
      // Ordinary builders must hold the same use rights before it can be offered to them.
      for (const name of ["sample-accounting", "sample-accounting-rest"]) {
        const connection = await json(root.request, "GET", `/api/v1/assets/connection/${name}`);
        await json(root.request, "POST", "/api/v1/instance/access/grants", {
          holderKind: "user",
          holderId: actor.me.id,
          action: "connection.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: connection.id
        });
      }
      await writeFile(
        process.env.AGENT_STORIES_ACTOR_FILE,
        JSON.stringify({ ...people[0], id: actor.me.id }),
        { mode: 0o600 }
      );
      const observations = {};
      const runs = [];
      const observers = [];
      const story = {
        id,
        actor,
        workspace,
        people,
        root,
        errors,
        startedAt,
        deadline,
        observations,
        watch,
        async start(prompt) {
          if (
            await access(resolve(folder, "STOP")).then(
              () => true,
              () => false
            )
          )
            throw new Error("Invocation budget/deadline stopped new work");
          const started = await json(actor.context.request, "POST", "/api/v1/conversations/runs", {
            idempotencyKey: randomUUID(),
            agentName: "workflow_assistant",
            locale: "en",
            conversation: {
              title: `${id} synthetic trial`,
              collaborationWorkspaceId: workspace.id
            },
            message: { text: prompt }
          });
          const run = {
            conversationId: started.conversation.id,
            runId: started.run.id,
            eventsUrl: started.eventsUrl,
            prompt
          };
          runs.push(run);
          // SSE is observed, but no raw event or assistant prose is written to disk.
          const controller = new AbortController();
          observers.push(controller);
          const cookies = await actor.context.cookies(api);
          const url = new URL(started.eventsUrl, api);
          if (url.origin !== new URL(api).origin) throw new Error("Refusing foreign SSE URL");
          const observation = (async () => {
            const response = await fetch(url, {
              headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
              signal: controller.signal
            });
            if (!response.ok || !response.body) throw new Error("SSE unavailable");
            const reader = response.body.getReader();
            try {
              while (!(await reader.read()).done) {
                /* bytes deliberately discarded */
              }
            } finally {
              reader.releaseLock();
            }
          })();
          observation.catch(() => {
            if (!controller.signal.aborted) errors.push("SSE observation failed");
          });
          await actor.page.goto(`/w/${workspace.id}/c/${run.conversationId}`);
          return run;
        },
        async waitRun(run) {
          const row = await until(
            async () => (await sql`select status from agent_runs where id=${run.runId}`)[0],
            terminal,
            deadline
          );
          expect(row.status).toBe("completed");
          const calls =
            await sql`select id,provider_id,model,binding_id,total_tokens,customer_billable_cost from model_usage_events where agent_run_id=${run.runId}`;
          expect(calls.length, "case must call the real configured model").toBeGreaterThan(0);
          const [binding] =
            await sql`select model_binding_id,reasoning_effort from agent_runs where id=${run.runId}`;
          observations.model = [
            ...(observations.model ?? []),
            ...calls.map((call) => ({
              id: call.id,
              runId: run.runId,
              provider: call.provider_id,
              model: call.model,
              bindingId: call.binding_id,
              tokens: call.total_tokens,
              status: call.customer_billable_cost?.status,
              reasoningEffort: binding.reasoning_effort
            }))
          ];
          for (const call of calls) {
            expect(call.provider_id).not.toBe("deterministic");
            expect(call.customer_billable_cost?.status).toBe("settled");
          }
          return row;
        },
        async created(kind, run) {
          const rows =
            await sql`select a.id,a.name,a.kind,a.scope_kind as "scopeKind",a.scope_id as "scopeId",a.active_revision_id as "revisionId",a.created_at as "createdAt",r.actor->>'userId' as "actorId",r.revision,
          coalesce(c.conversation_id,r.origin->>'conversationId') as "conversationId",
          o.origin->>'agentRunId' as "runId"
          from config_assets a join config_asset_revisions r on r.asset_id=a.id and r.revision=1
          left join conversation_created_assets c on c.asset_id=a.id
          join operation_runs o on o.conversation_id=${run.conversationId} and o.status='done'
            and o.origin->>'agentRunId'=${run.runId}
            and (o.output #>> '{value,name}' = a.name and o.output #>> '{value,created}'='true' and o.output #>> '{value,saved}'='true')
          where a.kind=${kind} and coalesce(c.conversation_id,r.origin->>'conversationId')=${run.conversationId}`;
          const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
          expect(unique).toHaveLength(1);
          const row = unique[0];
          createdOracle(row, {
            actorId: actor.me.id,
            conversationId: run.conversationId,
            runId: run.runId,
            startedAt,
            seededIds: stack.seededIds,
            kind
          });
          observations.id = row.id;
          observations.name = row.name;
          observations.actorId = row.actorId;
          observations.conversationId = row.conversationId;
          observations.runId = row.runId;
          observations.revision = row.revision;
          observations.createdAt = new Date(row.createdAt).toISOString();
          const query = new URLSearchParams();
          if (kind !== "workflow") query.set("files", "true");
          if (row.scopeKind === "workspace") query.set("workspaceId", row.scopeId);
          const asset = await json(
            actor.context.request,
            "GET",
            `/api/v1/assets/${kind}/${encodeURIComponent(row.name)}?${query}`
          );
          expect(asset.id).toBe(row.id);
          await writeFile(
            resolve(folder, `${id}.generated.json`),
            JSON.stringify(
              evidence({
                id: asset.id,
                kind,
                revision: asset.revision,
                source: JSON.stringify({ files: asset.files, config: asset.config }),
                hash: hash(JSON.stringify({ files: asset.files, config: asset.config }))
              }),
              null,
              2
            ),
            { mode: 0o600 }
          );
          return row;
        }
      };
      try {
        await use(story);
        expect(errors, "strict browser errors").toEqual([]);
      } finally {
        for (const observer of observers) observer.abort();
        for (const run of runs) {
          const [row] = await sql`select status from agent_runs where id=${run.runId}`;
          if (row && !terminal(row))
            await json(
              actor.context.request,
              "POST",
              `/api/v1/conversations/${run.conversationId}/runs/${run.runId}/cancel`,
              {},
              [200, 409]
            ).catch(() => {});
        }
        if (actor.page.url().startsWith(`${ui}/w/`))
          await actor.page.screenshot({ path: resolve(folder, `${id}.png`) }).catch(() => {});
        const status = testInfo.status === "passed" && errors.length === 0 ? "pass" : "fail";
        // Keep a final snapshot even when the story's deadline has already expired.
        // Unsettled title/worker calls remain conservative reservations in usageTotal.
        const usageRows = (
          await sql`select id,status,total_tokens,counted_tokens,counted_cost_micros,customer_billable_cost from model_usage_events`
        ).filter((row) => !baseline.has(row.id));
        const result = evidence(
          {
            scenario: id,
            status,
            startedAt,
            endedAt: new Date().toISOString(),
            elapsedMs: Date.now() - Date.parse(startedAt),
            usage: usageTotal(usageRows),
            observations,
            assertions: observations,
            runs: runs.map(({ conversationId, runId }) => ({ conversationId, runId })),
            errors: errors.length,
            prompt: runs.map((r) => r.prompt).join("\n"),
            message: testInfo.error?.message?.split("\n").slice(0, 8).join("\n")
          },
          [...Object.values(auth.secrets), ...people.map((person) => person.password)]
        );
        await writeFile(resolve(folder, `${id}.json`), JSON.stringify(result, null, 2), {
          mode: 0o600
        });
        const instanceAssets =
          await sql`select distinct a.kind,a.name,r.revision from config_assets a join config_asset_revisions r on r.id=a.active_revision_id join conversation_created_assets c on c.asset_id=a.id where c.conversation_id in ${sql(runs.map((r) => r.conversationId).length ? runs.map((r) => r.conversationId) : ["none"])} and a.scope_kind='instance' and r.actor->>'userId'=${actor.me.id}`;
        for (const asset of instanceAssets)
          await json(
            root.request,
            "DELETE",
            `/api/v1/assets/${asset.kind}/${encodeURIComponent(asset.name)}`,
            { expectedRevision: asset.revision },
            [200, 202, 204]
          ).catch(() => errors.push("asset cleanup failed"));
      }
    } finally {
      // Only the workspace owner deletes it. Setup may delete the people once ownership is gone.
      const cleanupDeadline = Date.now() + FIXTURE_CLEANUP_MS;
      if (workspace && actor)
        await json(
          actor.context.request,
          "DELETE",
          `/api/v1/workspaces/${workspace.id}`,
          { confirmName: workspace.name },
          [200, 202, 204]
        ).catch(() => {
          errors.push("workspace cleanup failed");
        });
      if (workspace && !errors.includes("workspace cleanup failed"))
        await until(
          async () =>
            (await sql`select id from collaboration_workspaces where id=${workspace.id}`).length,
          (count) => count === 0,
          cleanupDeadline
        ).catch(() => errors.push("workspace cleanup failed"));
      for (const person of people)
        await json(
          root.request,
          "DELETE",
          `/api/v1/instance/users/${person.id}`,
          undefined,
          [200, 202, 204]
        ).catch(() => {
          errors.push("actor cleanup failed");
        });
      if (people.length && !errors.includes("actor cleanup failed"))
        await until(
          async () =>
            (
              await sql`select id from product_users where id in ${sql(people.map((person) => person.id))}`
            ).length,
          (count) => count === 0,
          cleanupDeadline
        ).catch(() => errors.push("actor cleanup failed"));
      for (const context of contexts) await context.close();
      await root.close();
      if (errors.some((error) => error.includes("cleanup"))) {
        const original = await readFile(resolve(folder, `${id}.json`), "utf8")
          .then(JSON.parse)
          .catch(() => ({ scenario: id }));
        await writeFile(
          resolve(folder, `${id}.json`),
          JSON.stringify({
            ...original,
            verdict: original.status,
            status: "blocked",
            code: "fixture_cleanup_failure",
            message: errors.filter((error) => error.includes("cleanup")).join("; ")
          }),
          { mode: 0o600 }
        );
      }
    }
  }
});
export { expect };
export async function saveObservation(story) {
  await writeFile(
    resolve(folder, `${story.id}.observation.json`),
    JSON.stringify(evidence(story.observations), null, 2),
    { mode: 0o600 }
  );
}
export const frame = (page) =>
  page.getByTestId("page-preview-frame").contentFrame().frameLocator("iframe");
