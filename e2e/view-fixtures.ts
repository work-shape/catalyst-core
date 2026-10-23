import { randomUUID } from "node:crypto";
import type { APIRequestContext, BrowserContext, FrameLocator, Page } from "@playwright/test";
import postgres from "postgres";
import { z } from "zod";
import { expect } from "./test";

// What the specs about generated views share: where the instance is, how a view gets into a
// conversation, and where on the page it then is.

export const apiOrigin = new URL(process.env.E2E_API_URL ?? "http://127.0.0.1:4210").origin;
export const uiOrigin = new URL(process.env.E2E_UI_URL ?? "http://127.0.0.1:5273").origin;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${process.env.E2E_HOST ?? "127.0.0.1"}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
/**
 * The member of the view specs alone. Every view is a conversation of its own, and a member
 * shared with another spec file would fill that file's rail with them.
 */
const user = { email: "e2e-views@example.test", password: "e2e-views-password" };

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
  html: string,
  personalData = false
): Promise<{ id: string; title: string; collaborationWorkspaceId: string }> {
  const title = `View ${randomUUID()}`;
  let markedId: string | undefined;
  if (personalData) {
    const created = await request.post(`${apiOrigin}/api/v1/conversations`, {
      headers,
      data: { title }
    });
    expect(created.ok()).toBe(true);
    markedId = z.object({ id: z.string() }).parse(await created.json()).id;
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`update conversations set personal_data_at = now() where id = ${markedId}`;
    } finally {
      await sql.end();
    }
  }
  const started = await request.post(
    markedId
      ? `${apiOrigin}/api/v1/conversations/${encodeURIComponent(markedId)}/runs`
      : `${apiOrigin}/api/v1/conversations/runs`,
    {
      headers,
      data: {
        idempotencyKey: randomUUID(),
        ...(markedId ? {} : { conversation: { title } }),
        message: {
          text: showViewMessage(html)
        }
      }
    }
  );
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

// Every test gets its own browser context; only the authenticated cookie state is reused.
let viewCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | undefined;

export async function signIn(page: Page, origin: string): Promise<Record<string, string>> {
  const headers = { Origin: origin };
  if (viewCookies) {
    await page.context().addCookies(viewCookies);
    return headers;
  }
  const response = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers,
    data: { ...user, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  viewCookies = await page.context().cookies();
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

/** Waits for the DOM observers and browser default actions of the preceding task to finish. */
export async function browserTurn(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  );
}

/**
 * Seeds a completed display for sandbox probes. Model pacing is unrelated to containment.
 * The marked-conversation test still calls showView to prove the server's private-row policy.
 * The interface composes and frames this stored display exactly as it does a tool result.
 */

export async function storeView(
  request: APIRequestContext,
  headers: Record<string, string>,
  html: string,
  kind: "html.rendered" | "private_hydrated_view"
): Promise<{ id: string }> {
  return storeViews(request, headers, [{ html, kind, title: viewTitle }]);
}

export async function storeViews(
  request: APIRequestContext,
  headers: Record<string, string>,
  views: readonly { html: string; kind: "html.rendered" | "private_hydrated_view"; title: string }[]
): Promise<{ id: string }> {
  const created = await request.post(`${apiOrigin}/api/v1/conversations`, {
    headers,
    data: { title: `View ${randomUUID()}` }
  });
  expect(created.ok()).toBe(true);
  const conversation = z.object({ id: z.string() }).parse(await created.json());
  const rows = views.flatMap(({ html, kind, title }) => {
    const runId = `arun_${randomUUID()}`;
    const toolCall = {
      toolCallId: `toolcall_${randomUUID()}`,
      toolName: "show_view",
      input: { html, mode: "inline", title }
    };
    const runtime = (data: Record<string, unknown>) => ({
      agentRuntime: { version: 1, runId, ...data }
    });
    return [
      { role: "user", text: "Show the sandbox fixture", metadata: {} },
      {
        role: "assistant",
        text: "",
        metadata: runtime({ kind: "assistant_tool_calls", toolCalls: [toolCall] })
      },
      {
        role: "tool",
        text: "View fixture",
        metadata: runtime({
          kind: "tool_result",
          ...toolCall,
          result: {
            status: "success",
            output: {},
            display: { kind, version: 1, mode: "inline", title, data: { html, title } }
          }
        })
      },
      {
        role: "assistant",
        text: "View fixture",
        metadata: runtime({ kind: "assistant_final", finishStatus: "completed" })
      }
    ];
  });
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const [index, row] of rows.entries()) {
      await sql`insert into messages (id,client_instance_id,conversation_id,role,text,created_at,metadata)
        values (${`msg_${randomUUID()}`},'demo-e2e',${conversation.id},${row.role},${row.text},${new Date(Date.now() + index)},${sql.json(row.metadata)})`;
    }
  } finally {
    await sql.end();
  }
  return conversation;
}
