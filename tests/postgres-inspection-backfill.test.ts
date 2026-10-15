import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { expect, inject, it } from "vitest";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  asManagedArtifactId,
  createToolResultMetadata,
  type JsonObject,
  type SupportedImageMimeType,
  type JsonValue
} from "@vivd-catalyst/core";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import { listConversationResources } from "@vivd-catalyst/chat-server";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const clientInstanceId = asClientInstanceId("inspection-backfill");
const conversationId = asConversationId("conv_inspection");
const collaborationWorkspaceId = asCollaborationWorkspaceId("cws_inspection");

it("backfills only proven path inspections and hides them from resources and file search", async () => {
  const before = migrationsUntil({
    name: "workspace_inspection_backfill",
    including: false
  });
  const databaseUrl = await fixtures.database("inspection-backfill", false);
  const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
  try {
    await migrateDatabase({
      databaseUrl,
      migrationsDirectory: before.directory
    });
    await seedConversation(sql);
    const inspected: string[] = [];
    for (const [kind, mimeType] of [
      ["image.png", "image/png"],
      ["image.jpeg", "image/jpeg"],
      ["image.webp", "image/webp"],
      ["image.gif", "image/gif"]
    ] as const) {
      const id = `art_old_${kind}`;
      inspected.push(id);
      await seedArtifact(sql, id, {}, kind, mimeType);
      await seedMessage(
        sql,
        id,
        previewResult(id, { paths: ["/workspace/previews/check.png"] }, kind, mimeType)
      );
    }
    await seedArtifact(sql, "art_old_source", {
      source: "execution_workspace_preview"
    });
    inspected.push("art_old_source");
    // A second look previously made a second random row, even for identical bytes.
    await seedArtifact(sql, "art_second_look");
    await seedMessage(
      sql,
      "art_second_look",
      previewResult("art_second_look", { path: "previews/check.png" })
    );
    inspected.push("art_second_look");

    // Each look-alike fails exactly one backfill guard.
    const otherConversationId = asConversationId("conv_other_inspection");
    await seedConversation(sql, otherConversationId);
    await seedArtifact(sql, "art_wrong_conversation", {
      workspacePath: "previews/wrong-conversation.png"
    });
    await seedMessage(
      sql,
      "art_wrong_conversation",
      previewResult(
        "art_wrong_conversation",
        { path: "previews/wrong-conversation.png" },
        undefined,
        undefined,
        "previews/wrong-conversation.png"
      ),
      "tool",
      clientInstanceId,
      otherConversationId
    );
    await seedArtifact(sql, "art_source_file", { workspacePath: "previews/source-file.png" });
    await seedMessage(
      sql,
      "art_source_file",
      previewResult(
        "art_source_file",
        { path: "previews/source-file.png" },
        undefined,
        undefined,
        "previews/source-file.png"
      )
    );
    await seedArtifact(sql, "art_failed_result", { workspacePath: "previews/failed-result.png" });
    await seedMessage(
      sql,
      "art_failed_result",
      previewResult(
        "art_failed_result",
        { path: "previews/failed-result.png" },
        undefined,
        undefined,
        "previews/failed-result.png"
      )
    );
    await sql`update messages set metadata = jsonb_set(
      metadata, '{agentRuntime,result,status}', '"error"'::jsonb
    ) where id = 'msg_art_failed_result'`;
    await seedArtifact(sql, "art_path_mismatch", { workspacePath: "previews/path-mismatch.png" });
    await seedMessage(
      sql,
      "art_path_mismatch",
      previewResult(
        "art_path_mismatch",
        { path: "previews/different.png" },
        undefined,
        undefined,
        "previews/different.png"
      )
    );
    await seedArtifact(sql, "art_outside_previews", { workspacePath: "artifacts/chart.png" });
    await seedMessage(
      sql,
      "art_outside_previews",
      previewResult(
        "art_outside_previews",
        { path: "artifacts/chart.png" },
        undefined,
        undefined,
        "artifacts/chart.png"
      )
    );

    // Same path/bytes/name/kind as the inspections, but explicitly promoted to the person.
    await seedArtifact(sql, "art_promoted");
    await seedMessage(
      sql,
      "art_promoted",
      previewResult("art_promoted", { artifactId: "art_promoted" })
    );
    await seedArtifact(sql, "art_no_evidence", {
      workspacePath: "previews/no-evidence.png"
    });
    await seedArtifact(sql, "art_wrong_client", {
      workspacePath: "previews/wrong-client.png"
    });
    await seedMessage(
      sql,
      "art_wrong_client",
      previewResult(
        "art_wrong_client",
        { path: "previews/wrong-client.png" },
        undefined,
        undefined,
        "previews/wrong-client.png"
      ),
      "tool",
      "other-instance"
    );
    await seedArtifact(sql, "art_user_message", {
      workspacePath: "previews/user-message.png"
    });
    await seedMessage(
      sql,
      "art_user_message",
      previewResult(
        "art_user_message",
        { path: "previews/user-message.png" },
        undefined,
        undefined,
        "previews/user-message.png"
      ),
      "user"
    );
    await seedArtifact(sql, "art_other_tool", {
      workspacePath: "previews/other-tool.png"
    });
    const otherTool = previewResult(
      "art_other_tool",
      { path: "previews/other-tool.png" },
      undefined,
      undefined,
      "previews/other-tool.png"
    );
    await seedMessage(sql, "art_other_tool", {
      agentRuntime: {
        ...runtime(otherTool),
        toolName: "workspace.promote_artifact"
      }
    });
    await seedArtifact(sql, "art_explicit_purpose", {
      purpose: "deliverable",
      workspacePath: "previews/purpose.png"
    });
    await seedMessage(
      sql,
      "art_explicit_purpose",
      previewResult(
        "art_explicit_purpose",
        { path: "previews/purpose.png" },
        undefined,
        undefined,
        "previews/purpose.png"
      )
    );
    // A path call referring to a different artifact must not hide this one.
    await seedArtifact(sql, "art_unrelated", {
      workspacePath: "previews/unrelated.png"
    });
    await seedMessage(
      sql,
      "unrelated",
      previewResult("art_missing", { path: "previews/unrelated.png" })
    );
    // Historical malformed JSON must neither match nor abort the migration.
    await seedMessage(sql, "malformed", {
      agentRuntime: {
        version: 1,
        kind: "tool_result",
        toolName: "workspace.preview_images",
        input: { path: "previews/check.png" },
        result: { status: "success", artifacts: {} }
      }
    });

    // A user's uploaded screenshot keeps the same filename and remains searchable.
    await sql`insert into managed_files (id, client_instance_id, owner_user_id, filename,
      mime_type, byte_size, checksum, object_key, status, created_at)
      values ('file_user', ${clientInstanceId}, 'owner', 'check.png', 'image/png', 8,
        'same-checksum', 'user-upload-object', 'available', now())`;
    await sql`update managed_artifacts set source_file_id = 'file_user' where id = 'art_source_file'`;
    await sql`insert into conversation_attachments (id, client_instance_id, conversation_id,
      message_id, file_id, filename, mime_type, byte_size, checksum, status, format,
      warnings, created_at, updated_at)
      values ('att_user', ${clientInstanceId}, ${conversationId}, 'msg_art_user_message',
        'file_user', 'check.png', 'image/png', 8, 'same-checksum', 'ready', 'png',
        '[]'::jsonb, now(), now())`;
    const upload = await sql`select * from managed_files`;
    const attachments = await sql`select * from conversation_attachments`;
    const original = await sql<
      { id: string; metadata: JsonObject }[]
    >`select * from managed_artifacts order by id`;
    expect(await migrateDatabase({ databaseUrl })).toEqual([before.tag]);
    const migrated = await sql<
      { id: string; metadata: JsonObject }[]
    >`select * from managed_artifacts order by id`;
    expect(migrated).toEqual(
      original.map((row) =>
        inspected.includes(row.id)
          ? { ...row, metadata: { ...row.metadata, purpose: "inspection" } }
          : row
      )
    );
    expect(await sql`select * from managed_files`).toEqual(upload);
    expect(await sql`select * from conversation_attachments`).toEqual(attachments);
    expect(await migrateDatabase({ databaseUrl })).toEqual([]);
    // Reapply the SQL itself, not just the runner's journal skip: no rows are rewritten.
    const versions = await sql`select id, xmin::text from managed_artifacts order by id`;
    const source = await readFile(
      resolve("packages/postgres-store/migrations", `${before.tag}.sql`),
      "utf8"
    );
    await sql.begin(async (tx) => {
      for (const statement of source.split("--> statement-breakpoint")) await tx.unsafe(statement);
    });
    expect(await sql`select id, xmin::text from managed_artifacts order by id`).toEqual(versions);

    const store = await fixtures.stores(databaseUrl);
    try {
      const resources = await listConversationResources({
        store,
        clientInstanceId,
        conversationId
      });
      const found = await store.conversations.searchWorkspaceFiles({
        clientInstanceId,
        collaborationWorkspaceId,
        viewerUserId: "owner",
        kinds: ["generated_file", "upload"],
        page: { limit: 100 }
      });
      const visible = [
        "art_wrong_conversation",
        "art_source_file",
        "art_failed_result",
        "art_path_mismatch",
        "art_outside_previews",
        "art_promoted",
        "art_no_evidence",
        "art_wrong_client",
        "art_user_message",
        "art_other_tool",
        "art_explicit_purpose",
        "art_unrelated"
      ].sort();
      expect(resources.items.map((item) => item.resourceId).sort()).toEqual([
        ...visible.map((id) => `generated_file:${id}`),
        "source_file:att_user"
      ]);
      expect(found.map((item) => item.id).sort()).toEqual([...visible, "file_user"]);
    } finally {
      await store.close();
    }
  } finally {
    await sql.end();
    await fixtures.drop(databaseUrl);
    before.remove();
  }
});

function runtime(metadata: JsonObject): JsonObject {
  const value = metadata.agentRuntime;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing runtime metadata");
  return value;
}

function previewResult(
  id: string,
  input: JsonValue,
  kind = "image.png",
  mimeType: SupportedImageMimeType = "image/png",
  workspacePath = "previews/check.png"
): JsonObject {
  return createToolResultMetadata({
    runId: "run_old",
    toolCall: {
      toolCallId: `call_${id}`,
      toolName: "workspace.preview_images",
      input
    },
    result: {
      status: "success",
      output: {
        status: "ready",
        images: [
          {
            sourceArtifactId: id,
            imageArtifactId: id,
            status: "ready",
            mimeType
          }
        ]
      },
      artifacts: [
        {
          artifactId: asManagedArtifactId(id),
          kind,
          filename: "check.png",
          mimeType,
          modelVisibility: { type: "image", mimeType },
          metadata: { sourceArtifactId: id, status: "ready", workspacePath }
        }
      ]
    },
    modelOutput: { text: "ready" }
  });
}

async function seedArtifact(
  sql: Sql,
  id: string,
  metadata: JsonObject = {},
  kind = "image.png",
  mimeType = "image/png"
): Promise<void> {
  const workspacePath =
    typeof metadata.workspacePath === "string" ? metadata.workspacePath : "previews/check.png";
  await sql`insert into managed_artifacts (
    id, client_instance_id, conversation_id, kind, object_key, filename, mime_type,
    byte_size, checksum, metadata, status, created_at
  ) values (
    ${id}, ${clientInstanceId}, ${conversationId}, ${kind}, 'same-workspace-object',
    ${workspacePath.split("/").pop() ?? "check.png"}, ${mimeType}, 8, 'same-checksum',
    ${sql.json({ source: "execution_workspace", workspaceId: "ews_old", workspacePath, ...metadata })},
    'available', '2026-08-18T00:00:00Z'
  )`;
}

async function seedMessage(
  sql: Sql,
  id: string,
  metadata: JsonObject,
  role = "tool",
  instance: string = clientInstanceId,
  conversation: string = conversationId
): Promise<void> {
  await sql`insert into messages (id, client_instance_id, conversation_id, role, text, created_at, metadata)
    values (${`msg_${id}`}, ${instance}, ${conversation}, ${role}, '', now(), ${sql.json(metadata)})`;
}

async function seedConversation(sql: Sql, id = conversationId): Promise<void> {
  await sql`insert into collaboration_workspaces (id, client_instance_id, kind, name, visibility, created_at, updated_at)
    values (${collaborationWorkspaceId}, ${clientInstanceId}, 'shared', 'Test', 'private', now(), now())
    on conflict do nothing`;
  await sql`insert into conversations (id, client_instance_id, collaboration_workspace_id, created_by_user_id,
    created_by_external_user_id, visibility, title, status, created_at, updated_at, retained_until)
    values (${id}, ${clientInstanceId}, ${collaborationWorkspaceId}, 'owner', 'owner',
      'workspace', 'Test', 'active', now(), now(), now() + interval '1 day')`;
}
