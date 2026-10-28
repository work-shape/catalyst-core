import { and, asc, eq } from "drizzle-orm";
import { AppError, type ConfigAssetStore, type PersonalChatSkill } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { collaborationWorkspaces, configAssets, personalChatSkills } from "./schema";

// The skills a person uses in their own chats (SCOPE-MYCHATS). Every read and write joins the
// skill to the Personal Workspace of the person it names: a skill another workspace owns is
// none of theirs, whoever asks.

/** The active skills the person's Personal Workspace owns, joined with their switch. */
function ownSkills(
  db: PostgresConnection,
  clientInstanceId: string,
  userId: string,
  name?: string
) {
  return db
    .select({ id: configAssets.id, name: configAssets.name, on: personalChatSkills.assetId })
    .from(configAssets)
    .innerJoin(
      collaborationWorkspaces,
      and(
        eq(collaborationWorkspaces.id, configAssets.scopeId),
        eq(collaborationWorkspaces.clientInstanceId, clientInstanceId),
        eq(collaborationWorkspaces.kind, "personal"),
        eq(collaborationWorkspaces.personalUserId, userId)
      )
    )
    .leftJoin(personalChatSkills, eq(personalChatSkills.assetId, configAssets.id))
    .where(
      and(
        eq(configAssets.clientInstanceId, clientInstanceId),
        eq(configAssets.kind, "skill"),
        eq(configAssets.scopeKind, "workspace"),
        eq(configAssets.status, "active"),
        name === undefined ? undefined : eq(configAssets.name, name)
      )
    );
}

export async function listPersonalChatSkills(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listPersonalChatSkills"]>[0]
): Promise<PersonalChatSkill[]> {
  const rows = await ownSkills(db, input.clientInstanceId, input.userId).orderBy(
    asc(configAssets.name)
  );
  return rows.map((row) => ({ name: row.name, inMyChats: row.on !== null }));
}

export async function setPersonalChatSkill(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["setPersonalChatSkill"]>[0]
): Promise<PersonalChatSkill> {
  const [skill] = await ownSkills(db, input.clientInstanceId, input.userId, input.skillName).limit(
    1
  );
  // Another person's skill answers as one that does not exist: a Personal Workspace is private.
  if (!skill) throw new AppError("NOT_FOUND", `Skill '${input.skillName}' was not found`);
  if (input.inMyChats) {
    await db
      .insert(personalChatSkills)
      .values({
        assetId: skill.id,
        clientInstanceId: input.clientInstanceId,
        updatedAt: new Date()
      })
      .onConflictDoNothing();
  } else {
    await db.delete(personalChatSkills).where(eq(personalChatSkills.assetId, skill.id));
  }
  return { name: skill.name, inMyChats: input.inMyChats };
}
