import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { apiBaseUrl } from "./chat-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// LU-5 (limits spec 3.3, check 13): the Breakdown of the Usage page has a row for each App and
// each Workflow a model call counted to, and a row opens the table narrowed to it. The sums are
// planted as the daily sums, which a model call writes with its event; the Breakdown reads
// nothing else.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const clientInstanceId = "demo-e2e";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

test("the Breakdown has a row for each App and each Workflow that used a model", async ({
  page
}) => {
  const suffix = randomUUID().slice(0, 8);
  const app = `quote-desk-${suffix}`;
  const workflow = `weekly-digest-${suffix}`;
  const provider = `e2e-usage-${suffix}`;
  const sql = postgres(databaseUrl, { max: 1 });
  const plant = (appName: string, workflowName: string, purpose: string, calls: number) =>
    sql`
      insert into model_usage_daily_rollups (client_instance_id, day, provider_id, model, region,
        purpose, agent_name, workspace_key, app_name, workflow_name, currency, model_call_count,
        input_tokens, output_tokens, total_tokens, settled_model_call_count,
        uncached_input_cost_micros, output_cost_micros)
      values (${clientInstanceId}, (now() at time zone 'utc')::date, ${provider}, 'gpt-e2e', 'eu',
        ${purpose}, '', '', ${appName}, ${workflowName}, 'EUR', ${calls}, ${calls * 1000},
        ${calls * 1000}, ${calls * 2000}, ${calls}, ${calls * 2000}, ${calls * 8000})`;
  try {
    await plant(app, "", "agent", 3);
    await plant("", workflow, "agent", 2);

    const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...superadmin, rememberMe: true }
    });
    expect(response.ok()).toBe(true);

    await page.goto("/settings/instance/usage");
    await page.getByRole("tab", { name: "Breakdown", exact: true }).click();
    const breakdown = page.getByTestId("usage-breakdown");

    await breakdown.getByLabel("Group by").selectOption("app");
    await expect(breakdown.locator(`[data-usage-row="${app}"]`)).toContainText("3");
    await expect(breakdown.locator(`[data-usage-row="${workflow}"]`)).toHaveCount(0);

    await breakdown.getByLabel("Group by").selectOption("workflow");
    await expect(breakdown.locator(`[data-usage-row="${workflow}"]`)).toContainText("2");
    await expect(breakdown.locator(`[data-usage-row="${app}"]`)).toHaveCount(0);
  } finally {
    await sql`delete from model_usage_daily_rollups where provider_id = ${provider}`;
    await sql.end();
  }
});

// LU-3 (limits spec 3.3): grouped by agent, the Breakdown counts the comments on each agent's
// answers and a count leads its reviewer to the Inbox narrowed to that agent; the table leaves
// as one CSV file. The comment is planted as a row of its own: the count reads nothing else.
test("the Breakdown by agent counts feedback, leads to the Inbox and downloads as CSV", async ({
  page
}) => {
  const suffix = randomUUID().slice(0, 8);
  const agent = `e2e-usage-agent-${suffix}`;
  const provider = `e2e-usage-${suffix}`;
  const feedbackId = `fb_e2e_${suffix}`;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      insert into model_usage_daily_rollups (client_instance_id, day, provider_id, model, region,
        purpose, agent_name, workspace_key, app_name, workflow_name, currency, model_call_count,
        input_tokens, output_tokens, total_tokens, settled_model_call_count,
        uncached_input_cost_micros, output_cost_micros)
      values (${clientInstanceId}, (now() at time zone 'utc')::date, ${provider}, 'gpt-e2e', 'eu',
        'agent', ${agent}, '', '', '', 'EUR', 4, 4000, 4000, 8000, 4, 8000, 32000)`;
    const [author] = await sql<{ id: string }[]>`
      select id from product_users where client_instance_id = ${clientInstanceId}
      order by id limit 1`;
    await sql`
      insert into feedback (id, client_instance_id, subject_kind, agent_name, author_user_id, text,
        state, created_at, updated_at)
      values (${feedbackId}, ${clientInstanceId}, 'message', ${agent}, ${author?.id ?? ""},
        'A planted comment', 'new', now(), now())`;

    const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
      data: { ...superadmin, rememberMe: true }
    });
    expect(response.ok()).toBe(true);

    await page.goto("/settings/instance/usage");
    await page.getByRole("tab", { name: "Breakdown", exact: true }).click();
    const breakdown = page.getByTestId("usage-breakdown");
    await breakdown.getByLabel("Group by").selectOption("agent");
    const row = breakdown.locator(`[data-usage-row="${agent}"]`);
    await expect(row).toContainText("4");
    await expect(breakdown.getByRole("columnheader", { name: "Feedback" })).toBeVisible();

    const download = page.waitForEvent("download");
    await breakdown.getByRole("button", { name: "Download CSV" }).click();
    const csv = await readFile(await (await download).path(), "utf8");
    expect(csv).toContain("Agent,Cost (EUR),Share,Calls,Tokens,Feedback");
    expect(csv).toMatch(new RegExp(`\\n${agent},[\\d.]+,[\\d.]*,4,8000,1\\r`, "u"));

    const count = row.getByRole("link", { name: `1: open the comments on ${agent} in the Inbox` });
    await expect(count).toHaveAttribute("href", `/inbox/agent/${agent}`);
    await count.click();
    await expect(page).toHaveURL(new RegExp(`/inbox/agent/${agent}$`, "u"));
    await expect(page.getByLabel("Filter by agent")).toHaveValue(agent);
  } finally {
    await sql`delete from feedback where id = ${feedbackId}`;
    await sql`delete from model_usage_daily_rollups where provider_id = ${provider}`;
    await sql.end();
  }
});
