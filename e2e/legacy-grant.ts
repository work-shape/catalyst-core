import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { Page } from "@playwright/test";

/** Historical instance state, never a new grant through the retired Namespace writer. */
export async function seedHistoricalGrant(
  page: Page,
  grant: { holderId: string; action: string; namespace: string }
): Promise<string> {
  const api = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
  const actor: { id: string; clientInstanceId: string } = await (
    await page.request.get(`${api}/api/v1/me`)
  ).json();
  const sql = postgres(
    process.env.E2E_DATABASE_URL ??
      `postgres://agent_chat:agent_chat@127.0.0.1:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`,
    { max: 1 }
  );
  const id = `grant_${randomUUID()}`;
  try {
    await sql`insert into permission_grants (id,client_instance_id,holder_kind,holder_id,action,effect,scope_kind,namespace,granted_by,created_at)
    values (${id},${actor.clientInstanceId},'user',${grant.holderId},${grant.action},'allow','namespace',${grant.namespace},${actor.id},now())`;
    return id;
  } finally {
    await sql.end();
  }
}
