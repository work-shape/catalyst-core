import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { asConversationId, type FileSearchStore, type FoundFile } from "@work-shape/catalyst-core";
import { containsPattern } from "./like-pattern";
import { keysetFilter } from "./paging";
import { listedConversations } from "./postgres-conversation-operations";
import type { PostgresConnection } from "./postgres-database";
import {
  conversationAttachments,
  conversations,
  fileSets,
  managedArtifacts,
  pages
} from "./schema";

type SearchInput = Parameters<FileSearchStore["searchWorkspaceFiles"]>[0];

interface FoundRow extends Record<string, unknown> {
  kind: FoundFile["kind"];
  id: string;
  name: string;
  mime_type: string | null;
  bytes: number;
  updated_at: Date | string;
  conversation_id: string;
  conversation_title: string;
}

/**
 * The Pages and files of the conversations a viewer may read in one workspace, in one
 * statement. The conversations are those of the workspace's list for that viewer, so a private
 * conversation of another member and an unsent draft add nothing. Each kind is read through
 * the index on its conversation; the cost grows with the files of those conversations, which
 * are sorted to answer one page.
 */
export async function searchWorkspaceFiles(
  db: PostgresConnection,
  input: SearchInput
): Promise<FoundFile[]> {
  if (input.kinds.length === 0) return [];
  const readable = drizzleSql`select ${conversations.id}, ${conversations.title} from ${conversations} where ${listedConversations(
    db,
    {
      clientInstanceId: input.clientInstanceId,
      collaborationWorkspaceId: input.collaborationWorkspaceId,
      scope: { kind: "viewer", userId: input.viewerUserId }
    }
  )}`;
  // An array, not a join: each kind is read through the index on its conversation, and no
  // estimate of a filter (the planner has none for the metadata of a made file) can turn it
  // into comparing every file with every conversation.
  const inReadable = (column: SQL) => drizzleSql`${column} = any(array(select id from readable))`;
  const branches: Record<FoundFile["kind"], SQL> = {
    // The newest revision of a Page gives its size and when it last changed.
    page: drizzleSql`
      select 'page' as kind, p.id, p.name, 'text/html' as mime_type,
        coalesce(latest.total_bytes, 0) as bytes,
        coalesce(latest.created_at, p.created_at) as updated_at, p.conversation_id
      from ${pages} p
      left join lateral (
        select f.total_bytes, f.created_at from ${fileSets} f
        where f.owner_kind = 'page' and f.owner_id = p.id
        order by f.number desc limit 1
      ) latest on true
      where p.client_instance_id = ${input.clientInstanceId}
        and ${inReadable(drizzleSql`p.conversation_id`)}`,
    // What was sent with a message; a draft is its sender's alone.
    upload: drizzleSql`
      select 'upload' as kind, a.file_id as id, a.filename as name, a.mime_type,
        a.byte_size as bytes, a.updated_at, a.conversation_id
      from ${conversationAttachments} a
      where a.client_instance_id = ${input.clientInstanceId}
        and ${inReadable(drizzleSql`a.conversation_id`)}
        and a.message_id is not null and a.status <> 'deleted'`,
    // The newest copy of each file an agent made, as a conversation's Resources list it.
    // Inspection rows are skipped before the newest is picked: the rule of
    // `isWorkspaceInspectionArtifact` in tool-execution, which the Resources list applies too.
    // An image the agent only looked at is not a file it made for the person, and a promoted
    // file looked at again keeps resolving to its promoted row.
    generated_file: drizzleSql`
      select * from (
        select distinct on (m.conversation_id, m.metadata->>'workspaceId', m.metadata->>'workspacePath')
          'generated_file' as kind, m.id,
          coalesce(m.filename, regexp_replace(m.metadata->>'workspacePath', '^.*/', '')) as name,
          m.mime_type, m.byte_size as bytes, m.created_at as updated_at, m.conversation_id
        from ${managedArtifacts} m
        where m.client_instance_id = ${input.clientInstanceId}
          and ${inReadable(drizzleSql`m.conversation_id`)}
          and m.status = 'available'
          and m.metadata->>'source' = 'execution_workspace'
          and jsonb_typeof(m.metadata->'workspaceId') = 'string'
          and jsonb_typeof(m.metadata->'workspacePath') = 'string'
          and coalesce(m.metadata->>'purpose', '') <> 'inspection'
          and m.id not like 'art\\_workspace\\_preview\\_%'
        order by m.conversation_id, m.metadata->>'workspaceId', m.metadata->>'workspacePath',
          m.created_at desc, m.id desc
      ) made`
  };
  const found = drizzleSql.join(
    input.kinds.map((kind) => branches[kind]),
    drizzleSql` union all `
  );
  const pattern = input.text === undefined ? undefined : containsPattern(input.text);
  const conditions = [
    pattern === undefined
      ? undefined
      : drizzleSql`(found.name ilike ${pattern} or readable.title ilike ${pattern})`,
    keysetFilter(input.page, [drizzleSql`found.updated_at`, drizzleSql`found.id`], true)
  ].filter((condition) => condition !== undefined);
  const rows = await db.execute<FoundRow>(drizzleSql`
    with readable as (${readable}), found as (${found})
    select found.*, readable.title as conversation_title
    from found join readable on readable.id = found.conversation_id
    ${conditions.length === 0 ? drizzleSql`` : drizzleSql`where ${drizzleSql.join(conditions, drizzleSql` and `)}`}
    order by found.updated_at desc, found.id desc
    limit ${input.page.limit}
  `);
  return rows.map((row): FoundFile => ({
    kind: row.kind,
    id: row.id,
    name: row.name,
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    bytes: Number(row.bytes),
    updatedAt: new Date(row.updated_at).toISOString(),
    conversation: { id: asConversationId(row.conversation_id), title: row.conversation_title }
  }));
}
