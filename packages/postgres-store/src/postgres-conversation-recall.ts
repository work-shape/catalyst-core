import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  asConversationId,
  asMessageId,
  RECALL_SEARCH_TIMEOUT_MS,
  RECALL_SNIPPET_MAX_CHARS,
  RecallSearchTooBroadError,
  type ConversationRecallStore,
  type RecallHit,
  type RecallMessage,
  type RecallRole
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { messages } from "./schema";

// Conversation recall over the store (RECALL): full text with the `simple` configuration,
// computed when the search runs, through the index on a conversation's messages. Only the
// user's and the agent's messages with text count: tool results, system notes and empty steps
// are no part of what was said.

type SearchInput = Parameters<ConversationRecallStore["searchRecallMessages"]>[0];
type ReadInput = Parameters<ConversationRecallStore["readRecallMessages"]>[0];

interface HitRow extends Record<string, unknown> {
  id: string;
  conversation_id: string;
  role: RecallRole;
  created_at: Date | string;
  rank: number | string;
  snippet: string;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  role: RecallRole;
  text: string;
  created_at: Date | string;
  run_id: string | null;
}

/** What was said: the user's and the agent's messages that hold text. */
const said = (alias: string) =>
  drizzleSql.raw(`${alias}.role in ('user', 'assistant') and ${alias}.text <> ''`);

/** The order messages were stored in, as the conversation shows them. */
const position = (alias: string) =>
  drizzleSql.raw(`(${alias}.created_at, ${alias}.storage_ordinal)`);

export async function searchRecallMessages(
  db: PostgresConnection,
  input: SearchInput
): Promise<RecallHit[]> {
  if (input.conversationIds.length === 0) return [];
  const ids = drizzleSql`array[${drizzleSql.join(
    input.conversationIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `
  )}]::text[]`;
  const before =
    input.before === undefined
      ? drizzleSql``
      : drizzleSql`and ${position("m")} < (select a.created_at, a.storage_ordinal from ${messages} a where a.client_instance_id = ${input.clientInstanceId} and a.id = ${input.before} and a.conversation_id = m.conversation_id)`;
  const perConversation =
    input.perConversation === undefined
      ? drizzleSql``
      : drizzleSql`where nth <= ${input.perConversation}`;
  const statement = drizzleSql`
    with q as (select to_tsquery('simple', ${input.tsQuery}) as query),
    matched as (
      select m.id, m.conversation_id, m.role, m.text, m.created_at, m.storage_ordinal,
        ts_rank(to_tsvector('simple', m.text), q.query) as rank
      from ${messages} m, q
      where m.client_instance_id = ${input.clientInstanceId}
        and m.conversation_id = any(${ids})
        and ${said("m")}
        ${before}
        and to_tsvector('simple', m.text) @@ q.query
    ),
    ranked as (
      select matched.*, row_number() over (
        partition by conversation_id order by rank desc, created_at desc, storage_ordinal desc
      ) as nth
      from matched
    ),
    top as (
      select * from ranked ${perConversation}
      order by rank desc, created_at desc, storage_ordinal desc
      limit ${input.limit}
    )
    select top.id, top.conversation_id, top.role, top.created_at, top.rank,
      ts_headline('simple', top.text, q.query,
        'StartSel=«, StopSel=», MaxWords=40, MinWords=15, MaxFragments=1') as snippet
    from top, q
    order by top.rank desc, top.created_at desc, top.storage_ordinal desc
  `;
  const rows = await withSearchTimeout(db, (tx) => tx.execute<HitRow>(statement));
  return rows.map((row) => ({
    conversationId: asConversationId(row.conversation_id),
    messageId: asMessageId(row.id),
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    snippet: snippetAroundMatch(row.snippet),
    rank: Number(row.rank)
  }));
}

/**
 * The search in a transaction of its own with the time limit of a recall search. A search that
 * runs into it is refused as too broad; the database's text does not leave the store.
 */
async function withSearchTimeout<T>(
  db: PostgresConnection,
  run: (tx: PostgresConnection) => Promise<T>
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        drizzleSql`select set_config('statement_timeout', ${String(RECALL_SEARCH_TIMEOUT_MS)}, true)`
      );
      return run(tx);
    });
  } catch (error) {
    if (isStatementTimeout(error)) throw new RecallSearchTooBroadError();
    throw error;
  }
}

function isStatementTimeout(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "57014") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The headline cut to the snippet's length, around the first marked match. */
function snippetAroundMatch(headline: string): string {
  const text = headline.replace(/\s+/gu, " ").trim();
  if (text.length <= RECALL_SNIPPET_MAX_CHARS) return text;
  const match = Math.max(text.indexOf("«"), 0);
  const start = Math.max(
    0,
    Math.min(
      match - Math.floor(RECALL_SNIPPET_MAX_CHARS / 3),
      text.length - RECALL_SNIPPET_MAX_CHARS
    )
  );
  const piece = text.slice(start, start + RECALL_SNIPPET_MAX_CHARS - 2);
  return `${start > 0 ? "…" : ""}${piece}${start + piece.length < text.length ? "…" : ""}`;
}

export async function readRecallMessages(
  db: PostgresConnection,
  input: ReadInput
): Promise<Awaited<ReturnType<ConversationRecallStore["readRecallMessages"]>>> {
  const nothing = { messages: [], moreBefore: false, moreAfter: false };
  const inConversation = drizzleSql`m.client_instance_id = ${input.clientInstanceId} and m.conversation_id = ${input.conversationId} and ${said("m")}`;
  const anchorId =
    "around" in input.anchor
      ? input.anchor.around
      : "after" in input.anchor
        ? input.anchor.after
        : "before" in input.anchor
          ? input.anchor.before
          : undefined;
  const anchor =
    anchorId === undefined
      ? undefined
      : drizzleSql`(select a.created_at, a.storage_ordinal from ${messages} a where a.client_instance_id = ${input.clientInstanceId} and a.conversation_id = ${input.conversationId} and a.id = ${anchorId})`;
  if (anchorId !== undefined) {
    const found = await db.execute<{ id: string }>(
      drizzleSql`select a.id from ${messages} a where a.client_instance_id = ${input.clientInstanceId} and a.conversation_id = ${input.conversationId} and a.id = ${anchorId}`
    );
    if (found.length === 0) return nothing;
  }
  const select = (where: SQL, order: "asc" | "desc", limit: number) =>
    db.execute<MessageRow>(drizzleSql`
      select m.id, m.role, m.text, m.created_at,
        m.metadata->'agentRuntime'->>'runId' as run_id
      from ${messages} m
      where ${inConversation} and ${where}
      order by m.created_at ${drizzleSql.raw(order)}, m.storage_ordinal ${drizzleSql.raw(order)}
      limit ${limit}
    `);
  let rows: MessageRow[];
  if ("around" in input.anchor && anchor) {
    const [earlier, from] = await Promise.all([
      select(drizzleSql`${position("m")} < ${anchor}`, "desc", AROUND),
      select(drizzleSql`${position("m")} >= ${anchor}`, "asc", AROUND + 1)
    ]);
    rows = [...[...earlier].reverse(), ...from];
  } else if ("before" in input.anchor && anchor) {
    rows = [
      ...(await select(drizzleSql`${position("m")} < ${anchor}`, "desc", input.limit))
    ].reverse();
  } else if ("after" in input.anchor && anchor) {
    rows = [...(await select(drizzleSql`${position("m")} > ${anchor}`, "asc", input.limit))];
  } else {
    rows = [...(await select(drizzleSql`true`, "asc", input.limit))];
  }
  const first = rows[0];
  const last = rows.at(-1);
  const exists = async (where: SQL) =>
    (
      await db.execute<{ found: boolean }>(
        drizzleSql`select exists (select 1 from ${messages} m where ${inConversation} and ${where}) as found`
      )
    )[0]?.found === true;
  // By the row itself: a timestamp read into JavaScript loses its microseconds.
  const at = (row: MessageRow) =>
    drizzleSql`(select b.created_at, b.storage_ordinal from ${messages} b where b.client_instance_id = ${input.clientInstanceId} and b.id = ${row.id})`;
  const [moreBefore, moreAfter] = await Promise.all([
    first
      ? exists(drizzleSql`${position("m")} < ${at(first)}`)
      : anchor && !("after" in input.anchor)
        ? exists(drizzleSql`${position("m")} < ${anchor}`)
        : Promise.resolve(false),
    last
      ? exists(drizzleSql`${position("m")} > ${at(last)}`)
      : anchor && !("before" in input.anchor)
        ? exists(drizzleSql`${position("m")} > ${anchor}`)
        : Promise.resolve(false)
  ]);
  const tools = await toolsOfRuns(db, input, rows);
  return {
    messages: rows.map((row): RecallMessage => {
      const names = row.role === "assistant" && row.run_id ? tools.get(row.id) : undefined;
      return {
        messageId: asMessageId(row.id),
        role: row.role,
        createdAt: new Date(row.created_at).toISOString(),
        text: row.text,
        ...(names && names.length > 0 ? { tools: names } : {})
      };
    }),
    moreBefore,
    moreAfter
  };
}

const AROUND = 5;

/**
 * The names of the tools the agent called in each turn the read shows, by the last of its
 * messages in the read: never their input or output.
 */
async function toolsOfRuns(
  db: PostgresConnection,
  input: ReadInput,
  rows: readonly MessageRow[]
): Promise<Map<string, string[]>> {
  const lastOfRun = new Map<string, string>();
  for (const row of rows) {
    if (row.role === "assistant" && row.run_id) lastOfRun.set(row.run_id, row.id);
  }
  if (lastOfRun.size === 0) return new Map();
  const runIds = drizzleSql`array[${drizzleSql.join(
    [...lastOfRun.keys()].map((id) => drizzleSql`${id}`),
    drizzleSql`, `
  )}]::text[]`;
  const calls = await db.execute<{ run_id: string; names: string[] | null }>(drizzleSql`
    select m.metadata->'agentRuntime'->>'runId' as run_id,
      array(select jsonb_array_elements(m.metadata->'agentRuntime'->'toolCalls')->>'toolName') as names
    from ${messages} m
    where m.client_instance_id = ${input.clientInstanceId}
      and m.conversation_id = ${input.conversationId}
      and m.metadata->'agentRuntime'->>'kind' = 'assistant_tool_calls'
      and m.metadata->'agentRuntime'->>'runId' = any(${runIds})
    order by m.created_at, m.storage_ordinal
  `);
  const byMessage = new Map<string, string[]>();
  for (const call of calls) {
    const messageId = lastOfRun.get(call.run_id);
    if (!messageId) continue;
    const names = byMessage.get(messageId) ?? [];
    for (const name of call.names ?? []) if (name && !names.includes(name)) names.push(name);
    byMessage.set(messageId, names);
  }
  return byMessage;
}
