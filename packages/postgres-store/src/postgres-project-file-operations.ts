import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  AppError,
  type ProjectFile,
  type ProjectFileStore,
  type ProjectFileVersion,
  type WriteProjectFileVersionInput,
  type WriteProjectFileVersionResult
} from "@work-shape/catalyst-core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { projectFiles, projectFileVersions, projects } from "./schema";

// The files of a project with their versions (PRJ-2). Every change takes the project's row
// lock, so the caps hold and two writes of one file are ordered: the second sees the first
// and is kept as a conflict copy where its writer had not seen it.

type FileRow = typeof projectFiles.$inferSelect;
type VersionRow = typeof projectFileVersions.$inferSelect;

export function createPostgresProjectFileStore(db: PostgresConnection): ProjectFileStore {
  return {
    async listProjectFiles(input) {
      const rows = await db
        .select()
        .from(projectFiles)
        .where(
          and(
            eq(projectFiles.clientInstanceId, input.clientInstanceId),
            eq(projectFiles.projectId, input.projectId),
            isNotNull(projectFiles.objectKey)
          )
        )
        .orderBy(asc(projectFiles.path));
      return rows.flatMap((row) => fileOf(row) ?? []);
    },
    async getProjectFile(input) {
      const [row] = await db
        .select()
        .from(projectFiles)
        .where(
          and(
            eq(projectFiles.clientInstanceId, input.clientInstanceId),
            eq(projectFiles.projectId, input.projectId),
            eq(projectFiles.path, input.path)
          )
        )
        .limit(1);
      return row ? fileOf(row) : undefined;
    },
    async listProjectFileVersions(input) {
      const rows = await db
        .select()
        .from(projectFileVersions)
        .where(
          and(
            eq(projectFileVersions.clientInstanceId, input.clientInstanceId),
            eq(projectFileVersions.projectId, input.projectId),
            eq(projectFileVersions.path, input.path)
          )
        )
        .orderBy(desc(projectFileVersions.version));
      return rows.map(versionOf);
    },
    async getProjectFileVersion(input) {
      const [row] = await db
        .select()
        .from(projectFileVersions)
        .where(
          and(
            eq(projectFileVersions.clientInstanceId, input.clientInstanceId),
            eq(projectFileVersions.projectId, input.projectId),
            eq(projectFileVersions.path, input.path),
            eq(projectFileVersions.version, input.version)
          )
        )
        .limit(1);
      return row ? versionOf(row) : undefined;
    },
    writeProjectFileVersion(input) {
      return db.transaction(async (tx) => {
        await lockProject(tx, input);
        return writeVersion(tx, input);
      });
    },
    moveProjectFiles(input) {
      return db.transaction(async (tx) => {
        await lockProject(tx, input);
        const folder = input.from.endsWith("/");
        const sources = await tx
          .select({ path: projectFiles.path })
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.projectId, input.projectId),
              folder
                ? sql`starts_with(${projectFiles.path}, ${input.from})`
                : eq(projectFiles.path, input.from)
            )
          );
        if (sources.length === 0) return { status: "missing" as const };
        const moves = sources.map(({ path }) => ({
          from: path,
          to: folder ? `${input.to}${path.slice(input.from.length)}` : input.to
        }));
        const targets = moves.map((move) => move.to);
        if (new Set(targets).size !== targets.length) return { status: "taken" as const };
        const taken = await tx
          .select({ path: projectFiles.path })
          .from(projectFiles)
          .where(
            and(eq(projectFiles.projectId, input.projectId), inArray(projectFiles.path, targets))
          )
          .limit(1);
        if (taken.length > 0) return { status: "taken" as const };
        // The versions follow their file through the key's ON UPDATE CASCADE.
        for (const move of moves) {
          await tx
            .update(projectFiles)
            .set({ path: move.to })
            .where(
              and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.path, move.from))
            );
        }
        return { status: "moved" as const, moved: moves.length };
      });
    },
    purgeProjectFile(input) {
      return db.transaction(async (tx) => {
        await lockProject(tx, input);
        const versions = await tx
          .select({ objectKey: projectFileVersions.objectKey })
          .from(projectFileVersions)
          .where(
            and(
              eq(projectFileVersions.projectId, input.projectId),
              eq(projectFileVersions.path, input.path)
            )
          );
        await tx
          .delete(projectFiles)
          .where(
            and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.path, input.path))
          );
        const releasedObjectKeys = await unreferenced(
          tx,
          input.projectId,
          versions.flatMap((version) => (version.objectKey ? [version.objectKey] : []))
        );
        return { versions: versions.length, releasedObjectKeys };
      });
    },
    projectFileUsage(input) {
      return usageOf(db, input.projectId);
    },
    async forgetProjectFileAuthor(input) {
      const versions = await db
        .update(projectFileVersions)
        .set({ byUserId: null })
        .where(
          and(
            eq(projectFileVersions.clientInstanceId, input.clientInstanceId),
            eq(projectFileVersions.byUserId, input.userId)
          )
        )
        .returning({ version: projectFileVersions.version });
      await db
        .update(projectFiles)
        .set({ updatedByUserId: null })
        .where(
          and(
            eq(projectFiles.clientInstanceId, input.clientInstanceId),
            eq(projectFiles.updatedByUserId, input.userId)
          )
        );
      return { versions: versions.length };
    }
  };
}

async function lockProject(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; projectId: string }
): Promise<void> {
  const [project] = await tx
    .select({ id: projects.assetId })
    .from(projects)
    .where(
      and(
        eq(projects.assetId, input.projectId),
        eq(projects.clientInstanceId, input.clientInstanceId)
      )
    )
    .for("update")
    .limit(1);
  if (!project) throw new AppError("NOT_FOUND", "Project is not available");
}

async function writeVersion(
  tx: PostgresTransaction,
  input: WriteProjectFileVersionInput
): Promise<WriteProjectFileVersionResult> {
  if (input.restores !== undefined && input.content !== null) {
    const kept = await tx
      .select({ version: projectFileVersions.version })
      .from(projectFileVersions)
      .where(
        and(
          eq(projectFileVersions.projectId, input.projectId),
          eq(projectFileVersions.path, input.path),
          eq(projectFileVersions.version, input.restores),
          eq(projectFileVersions.objectKey, input.content.objectKey)
        )
      )
      .limit(1);
    if (kept.length === 0) return { status: "missing", path: input.path };
  }
  const current = await currentRow(tx, input.projectId, input.path);
  const live = current?.objectKey != null;
  const currentVersion = current?.currentVersion ?? 0;
  const seen =
    input.replaces === undefined ||
    input.replaces === currentVersion ||
    (input.replaces === 0 && !live);

  if (input.content === null) {
    if (!current || !live) return { status: "missing", path: input.path };
    if (!seen) return { status: "conflict", path: input.path, currentVersion };
  } else if (live && current.checksum === input.content.checksum) {
    // The bytes the file has already: no new version and no conflict copy, whatever version the
    // writer had seen.
    const file = fileOf(current);
    if (file) return { status: "unchanged", file };
  } else if (!seen) {
    // A write over a file that is gone for good: there is no file to put a copy beside.
    if (!current && input.replaces !== undefined && input.replaces > 0) {
      return { status: "gone", path: input.path };
    }
    if (input.conflictPath === undefined) {
      return { status: "conflict", path: input.path, currentVersion };
    }
    const copyPath = await freePath(tx, input.projectId, input.conflictPath);
    const copy = await writeVersion(tx, {
      ...input,
      path: copyPath,
      replaces: 0,
      conflictPath: undefined,
      restores: undefined
    });
    if (copy.status !== "written") return copy;
    return {
      status: "conflict_copy",
      file: copy.file,
      changedPath: input.path,
      currentVersion,
      releasedObjectKeys: copy.releasedObjectKeys
    };
  }

  if (input.content !== null) {
    if (input.content.byteSize > input.limits.maxFileBytes) {
      return { status: "over_limit", limit: "file_bytes", limits: input.limits };
    }
    const usage = await usageOf(tx, input.projectId);
    if (!live && usage.files + 1 > input.limits.maxFiles) {
      return { status: "over_limit", limit: "files", limits: input.limits };
    }
    const stored = await tx
      .select({ objectKey: projectFileVersions.objectKey })
      .from(projectFileVersions)
      .where(
        and(
          eq(projectFileVersions.projectId, input.projectId),
          eq(projectFileVersions.objectKey, input.content.objectKey)
        )
      )
      .limit(1);
    const added = stored.length > 0 ? 0 : input.content.byteSize;
    if (usage.bytes + added > input.limits.maxProjectBytes) {
      return { status: "over_limit", limit: "project_bytes", limits: input.limits };
    }
  }

  const version = currentVersion + 1;
  const at = new Date(input.at);
  const content = input.content;
  const row = {
    currentVersion: version,
    objectKey: content?.objectKey ?? null,
    byteSize: content?.byteSize ?? 0,
    checksum: content?.checksum ?? null,
    mimeType: content?.mimeType ?? null,
    origin: input.origin,
    updatedByUserId: input.byUserId,
    conversationId: input.conversationId ?? null,
    updatedAt: at
  };
  const [file] = await tx
    .insert(projectFiles)
    .values({
      projectId: input.projectId,
      clientInstanceId: input.clientInstanceId,
      path: input.path,
      ...row
    })
    .onConflictDoUpdate({ target: [projectFiles.projectId, projectFiles.path], set: row })
    .returning();
  await tx.insert(projectFileVersions).values({
    projectId: input.projectId,
    clientInstanceId: input.clientInstanceId,
    path: input.path,
    version,
    objectKey: content?.objectKey ?? null,
    byteSize: content?.byteSize ?? 0,
    checksum: content?.checksum ?? null,
    mimeType: content?.mimeType ?? null,
    origin: input.origin,
    byUserId: input.byUserId,
    conversationId: input.conversationId ?? null,
    runId: input.runId ?? null,
    at
  });

  // The oldest versions past the cap go; their objects only where no kept version names them.
  const past = await tx
    .select({ version: projectFileVersions.version, objectKey: projectFileVersions.objectKey })
    .from(projectFileVersions)
    .where(
      and(
        eq(projectFileVersions.projectId, input.projectId),
        eq(projectFileVersions.path, input.path)
      )
    )
    .orderBy(desc(projectFileVersions.version))
    .offset(input.limits.versionsPerFile);
  if (past.length > 0) {
    await tx.delete(projectFileVersions).where(
      and(
        eq(projectFileVersions.projectId, input.projectId),
        eq(projectFileVersions.path, input.path),
        inArray(
          projectFileVersions.version,
          past.map((entry) => entry.version)
        )
      )
    );
  }
  const releasedObjectKeys = await unreferenced(
    tx,
    input.projectId,
    past.flatMap((entry) => (entry.objectKey ? [entry.objectKey] : []))
  );
  const previous = current && live ? { previousVersion: currentVersion } : {};
  if (content === null) {
    return {
      status: "deleted",
      path: input.path,
      version,
      previousVersion: currentVersion,
      releasedObjectKeys
    };
  }
  const written = file ? fileOf(file) : undefined;
  if (!written) throw new AppError("INTERNAL", "The project file was not written");
  return { status: "written", file: written, ...previous, releasedObjectKeys };
}

async function currentRow(
  tx: PostgresTransaction,
  projectId: string,
  path: string
): Promise<FileRow | undefined> {
  const [row] = await tx
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.path, path)))
    .limit(1);
  return row;
}

/** The path itself where no file has it, else the first free `name 2.ext`, `name 3.ext`. */
async function freePath(tx: PostgresTransaction, projectId: string, path: string): Promise<string> {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const split = dot > slash + 1 ? dot : path.length;
  for (let attempt = 1; ; attempt += 1) {
    const candidate =
      attempt === 1 ? path : `${path.slice(0, split)} ${String(attempt)}${path.slice(split)}`;
    if (!(await currentRow(tx, projectId, candidate))) return candidate;
  }
}

/** Of these objects, those no kept version of the project names. */
async function unreferenced(
  tx: PostgresTransaction,
  projectId: string,
  objectKeys: readonly string[]
): Promise<string[]> {
  const unique = [...new Set(objectKeys)];
  if (unique.length === 0) return [];
  const kept = await tx
    .select({ objectKey: projectFileVersions.objectKey })
    .from(projectFileVersions)
    .where(
      and(
        eq(projectFileVersions.projectId, projectId),
        inArray(projectFileVersions.objectKey, unique)
      )
    );
  const named = new Set(kept.map((row) => row.objectKey));
  return unique.filter((key) => !named.has(key));
}

async function usageOf(
  db: PostgresConnection,
  projectId: string
): Promise<{ files: number; bytes: number }> {
  const [files] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), isNotNull(projectFiles.objectKey)));
  // Each stored object counts once: a restored version names the object it restores.
  const [bytes] = await db.execute<{ bytes: string | null }>(sql`
    select coalesce(sum(byte_size), 0)::text as bytes from (
      select distinct on (object_key) byte_size
      from ${projectFileVersions}
      where project_id = ${projectId} and object_key is not null
    ) as stored`);
  return { files: files?.count ?? 0, bytes: Number(bytes?.bytes ?? 0) };
}

function fileOf(row: FileRow): ProjectFile | undefined {
  if (row.objectKey === null) return undefined;
  return {
    projectId: row.projectId,
    path: row.path,
    version: row.currentVersion,
    byteSize: row.byteSize,
    checksum: row.checksum ?? "",
    mimeType: row.mimeType ?? "application/octet-stream",
    origin: row.origin,
    ...(row.updatedByUserId ? { updatedByUserId: row.updatedByUserId } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    objectKey: row.objectKey
  };
}

function versionOf(row: VersionRow): ProjectFileVersion {
  return {
    projectId: row.projectId,
    path: row.path,
    version: row.version,
    deleted: row.objectKey === null,
    byteSize: row.byteSize,
    ...(row.checksum ? { checksum: row.checksum } : {}),
    ...(row.mimeType ? { mimeType: row.mimeType } : {}),
    origin: row.origin,
    ...(row.byUserId ? { byUserId: row.byUserId } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    at: row.at.toISOString(),
    ...(row.objectKey ? { objectKey: row.objectKey } : {})
  };
}
