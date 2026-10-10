import { randomUUID } from "node:crypto";
import type { APIRequestContext, FrameLocator, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { expect } from "./test";

// What the specs about generated views share: where the instance is, how a view gets into a
// conversation, and where on the page it then is.

export const apiOrigin = new URL(process.env.E2E_API_URL ?? "http://127.0.0.1:4210").origin;
export const uiOrigin = new URL(process.env.E2E_UI_URL ?? "http://127.0.0.1:5273").origin;
const databaseUrl = `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const user = { email: "e2e-user@example.test", password: "e2e-user-password" };

export const viewTitle = "Quarterly revenue";
const shellDirectory = `${apiOrigin}/app-runtime/view-shell/1/`;
/** The document every view is framed in, and its script. */
export const shellFiles = [`${shellDirectory}shell.html`, `${shellDirectory}shell.js`];

/**
 * The frame of the view itself. The frame the page holds is the shell the instance serves,
 * and the view is the one frame inside it.
 */
export function viewFrame(page: Page): FrameLocator {
  return page.frameLocator(`iframe[title="${viewTitle}"]`).first().frameLocator("iframe");
}

/** What the test model reads as a call of `show_view`. */
function showViewMessage(html: string): string {
  return `/tool show_view ${JSON.stringify({ html, mode: "inline", title: viewTitle })}`;
}

/** Runs `show_view` through the agent and returns the conversation that holds the view. */
export async function showView(
  request: APIRequestContext,
  headers: Record<string, string>,
  html: string
): Promise<{ id: string; title: string; collaborationWorkspaceId: string }> {
  const title = `View ${randomUUID()}`;
  const started = await request.post(`${apiOrigin}/api/v1/conversations/runs`, {
    headers,
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title },
      message: {
        text: showViewMessage(html)
      }
    }
  });
  expect(started.ok()).toBe(true);
  const { conversation } = z
    .object({
      conversation: z.object({ id: z.string(), collaborationWorkspaceId: z.string() })
    })
    .parse(await started.json());
  await expect
    .poll(async () => {
      const thread = await request.get(
        `${apiOrigin}/api/v1/conversations/${encodeURIComponent(conversation.id)}/thread`,
        { headers }
      );
      expect(thread.ok()).toBe(true);
      const snapshot = z
        .object({
          activeRun: z.unknown().optional(),
          messages: z.array(z.object({ role: z.string() }))
        })
        .parse(await thread.json());
      return snapshot.activeRun === undefined && snapshot.messages.some((m) => m.role === "tool");
    })
    .toBe(true);
  return { ...conversation, title };
}

export async function signIn(page: Page, origin: string): Promise<Record<string, string>> {
  const headers = { Origin: origin };
  const response = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers,
    data: { ...user, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  return headers;
}

/**
 * Overwrites fields of the display a conversation's `show_view` call stored, the way an earlier
 * release or another tool would have written them. Returns the stored display versions.
 */
export async function rewriteStoredDisplay(
  conversationId: string,
  display: Parameters<ReturnType<typeof postgres>["json"]>[0]
): Promise<(string | null)[]> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rewritten = await sql<{ version: string | null }[]>`
      update messages
      set metadata = jsonb_set(
        metadata,
        '{agentRuntime,result,display}',
        (metadata #> '{agentRuntime,result,display}') || ${sql.json(display)}
      )
      where conversation_id = ${conversationId} and role = 'tool'
      returning metadata #>> '{agentRuntime,result,display,version}' as version
    `;
    expect(rewritten).toHaveLength(1);
    return rewritten.map((row) => row.version);
  } finally {
    await sql.end();
  }
}
