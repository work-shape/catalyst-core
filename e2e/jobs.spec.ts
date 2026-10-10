import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { requestWithOrigin } from "./request-with-origin";

// Instance > Jobs: an operator sees a job that died and retries it, and neither the job's
// payload nor the error message of the failure reaches the browser.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const databaseUrl = `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const PAYLOAD_MARKER = "payload-marker-4c1d9e";
const MESSAGE_MARKER = "provider-message-marker-8a2f07";
const jobsApiPattern = /\/api\/v1\/instance\/jobs/u;

async function withSql<Result>(run: (sql: postgres.Sql) => Promise<Result>): Promise<Result> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Writes a title job as the executor leaves it after its last attempt. Its conversation does
 * not exist, so the handler has nothing to do and the retried job completes at once.
 */
async function plantDeadJob(job: { id: string; subject: string }): Promise<void> {
  await withSql(
    (sql) => sql`
      insert into platform_jobs (
        id, client_instance_id, kind, subject, payload, status, run_after, attempts,
        max_attempts, error_code, error_message, correlation_id, created_at, finished_at
      )
      select
        ${job.id}, client_instance_id, 'conversation.generate_title', ${job.subject},
        ${sql.json({ conversationId: job.subject, userId: "usr_e2e_gone", note: PAYLOAD_MARKER })},
        'dead', now(), 2, 2, 'INTERNAL', ${MESSAGE_MARKER}, ${`corr_${job.id}`}, now(), now()
      from platform_jobs limit 1`
  );
}

/** A schedule tick that failed: the next tick is its retry, so the page offers none. */
async function plantFailedTick(id: string): Promise<void> {
  await withSql(
    (sql) => sql`
      insert into platform_jobs (
        id, client_instance_id, kind, payload, status, run_after, attempts, max_attempts,
        error_code, error_message, correlation_id, created_at, finished_at
      )
      select
        ${id}, client_instance_id, 'audit.prune', '{}', 'failed', now(), 1, 1, 'INTERNAL',
        ${MESSAGE_MARKER}, ${`corr_${id}`}, now(), now()
      from platform_jobs limit 1`
  );
}

function jobStatus(id: string): Promise<string | undefined> {
  return withSql(async (sql) => {
    const [row] = await sql<{ status: string }[]>`
      select status from platform_jobs where id = ${id}`;
    return row?.status;
  });
}

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("a superadmin sees a dead job with its error class and retries it", async ({ page }) => {
  const job = { id: `job_e2e_${randomUUID()}`, subject: `conv_e2e_${randomUUID()}` };
  const tickId = `job_e2e_tick_${randomUUID()}`;
  await plantDeadJob(job);
  await plantFailedTick(tickId);
  const answers: Promise<string>[] = [];
  page.on("response", (response) => {
    if (jobsApiPattern.test(response.url())) answers.push(response.text());
  });
  await signIn(page);

  await page.goto("/settings/instance/jobs");
  await expect(page.getByRole("heading", { name: "Jobs", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Jobs" })
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Failed and dead/u })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  const row = page.locator(`[data-job-id="${job.id}"]`);
  await expect(row).toContainText("conversation.generate_title");
  await expect(row).toContainText("Dead");
  await expect(row).toContainText("2 of 2");
  await expect(row).toContainText("INTERNAL");
  await expect(row).toContainText(job.subject);
  await expect(row).toContainText("Ended");

  // A failed tick is listed and has no retry.
  const tick = page.locator(`[data-job-id="${tickId}"]`);
  await expect(tick).toContainText("Failed");
  await expect(tick.getByRole("button")).toHaveCount(0);

  // The kinds with failures lead the summary, and a kind there narrows the list to itself.
  const firstKind = page.locator("[data-job-kind]").first();
  await expect(firstKind).toHaveAttribute(
    "data-job-kind",
    /^(audit\.prune|conversation\.generate_title)$/u
  );
  await page.getByRole("button", { name: "Show the jobs of conversation.generate_title" }).click();
  await expect(page.getByText("Kind: conversation.generate_title")).toBeVisible();
  await expect(tick).toHaveCount(0);
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(tick).toBeVisible();

  await row.getByRole("button", { name: `Actions for job ${job.id}` }).click();
  await page.getByRole("menuitem", { name: "Retry" }).click();
  const dialog = page.getByRole("dialog", { name: "Retry this job?" });
  await expect(dialog).toContainText("conversation.generate_title");
  const [retried] = await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === "POST" && jobsApiPattern.test(response.url())
    ),
    dialog.getByRole("button", { name: "Retry" }).click()
  ]);
  expect(retried.status()).toBe(200);

  await expect(row).toHaveCount(0);
  await expect.poll(() => jobStatus(job.id)).toBe("succeeded");

  const bodies = (await Promise.allSettled(answers)).flatMap((answer) =>
    answer.status === "fulfilled" ? [answer.value] : []
  );
  expect(bodies.some((body) => body.includes(job.id))).toBe(true);
  for (const text of [...bodies, await page.content()]) {
    expect(text).not.toContain(PAYLOAD_MARKER);
    expect(text).not.toContain(MESSAGE_MARKER);
  }
});

test("the summary marks a kind whose due jobs no worker takes", async ({ page }) => {
  // A kind that no process of the instance serves, as `agent_run.execute` is while no Agent
  // Run worker is up.
  const id = `job_e2e_untaken_${randomUUID()}`;
  await withSql(
    (sql) => sql`
      insert into platform_jobs (
        id, client_instance_id, kind, payload, status, run_after, attempts, max_attempts,
        correlation_id, created_at
      )
      select
        ${id}, client_instance_id, 'e2e.not_served', '{}', 'queued',
        now() - interval '5 minutes', 0, 1, ${`corr_${id}`}, now() - interval '5 minutes'
      from platform_jobs limit 1`
  );
  try {
    await signIn(page);
    await page.goto("/settings/instance/jobs");

    const kind = page.locator('[data-job-kind="e2e.not_served"]');
    await expect(kind.locator("[data-job-not-taken]")).toHaveText("No worker takes these");
  } finally {
    await withSql((sql) => sql`delete from platform_jobs where id = ${id}`);
  }
});
