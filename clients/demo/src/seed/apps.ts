import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { hasConnection, type SeedApi, type SeedAppFile } from "./api";
import { apps, personOf, type PersonKey, type SeedSharedWorkspace } from "./company";
import type { SeedStep } from "./step";

// The seeded Shared Workspaces and the Apps seeded into the company's.

/** The module and the asset kind Apps come with. */
const APPS_MODULE = "apps";
const APP_KIND = "app";

/**
 * Shared Workspaces with their members, each made by the person who owns it and found again by
 * its name. Answers their ids in the order given.
 */
export async function seedWorkspaces(
  as: (key: PersonKey) => Promise<SeedApi>,
  workspaces: readonly SeedSharedWorkspace[],
  steps: SeedStep[]
): Promise<string[]> {
  const ids: string[] = [];
  let created = 0;
  let added = 0;
  let members = 0;
  for (const workspace of workspaces) {
    const owner = await as(workspace.createdBy);
    const found = (await owner.listWorkspaces()).find(
      (candidate) => candidate.name === workspace.name
    );
    const { id } =
      found ??
      (await owner.createWorkspace({ name: workspace.name, description: workspace.description }));
    if (!found) created += 1;
    ids.push(id);

    const present = await owner.listWorkspaceMemberEmails(id);
    for (const key of workspace.members) {
      members += 1;
      const { email } = personOf(key);
      if (present.includes(email)) continue;
      await owner.addWorkspaceMember(id, email);
      added += 1;
    }
  }
  steps.push({ name: "workspaces", created, existing: workspaces.length - created });
  steps.push({ name: "workspace members", created: added, existing: members - added });
  return ids;
}

/** Every file below a folder, as a write of an App carries it. */
async function readSourceSet(directory: string): Promise<SeedAppFile[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      path: relative(directory, file).split(sep).join("/"),
      text: await readFile(file, "utf8")
    }))
  );
}

/**
 * The Apps of the company's workspace, where the instance has the module. An App is written
 * revision by revision from its source sets and published in between, so a run that stopped
 * half way is continued. An App that has all its revisions is left as it is.
 */
export async function seedApps(
  modules: Awaited<ReturnType<SeedApi["listModules"]>>,
  as: (key: PersonKey) => Promise<SeedApi>,
  workspaceId: string,
  assetsDir: string,
  steps: SeedStep[]
): Promise<void> {
  const name = "apps";
  const module = modules.find((candidate) => candidate.name === APPS_MODULE);
  if (module?.enabled !== true || !module.kinds.includes(APP_KIND)) {
    steps.push({
      name,
      created: 0,
      existing: 0,
      note: "This instance has no Apps module, so no App was seeded."
    });
    return;
  }
  let created = 0;
  const leftOut: string[] = [];
  for (const app of apps) {
    const author = await as(app.savedBy);
    if (app.connection !== undefined && !(await hasConnection(author, modules, app.connection))) {
      leftOut.push(`'${app.name}' (Connection '${app.connection}')`);
      continue;
    }
    const stored = async () =>
      (await author.listApps(workspaceId)).find((candidate) => candidate.name === app.name);
    let current = await stored();
    if (!current) created += 1;
    for (const [index, sourceSet] of app.sourceSets.entries()) {
      if ((current?.revision ?? 0) <= index) {
        await author.writeApp(
          workspaceId,
          app.name,
          await readSourceSet(join(assetsDir, "apps", app.name, sourceSet)),
          current?.revision
        );
        current = await stored();
      }
      if (index + 1 === app.publishedAfter && current?.publishedRevision === undefined) {
        if (!current) throw new Error(`The instance has no App '${app.name}' after writing it`);
        await author.publishApp(workspaceId, app.name, current.revision);
        current = await stored();
      }
    }
  }
  steps.push({
    name,
    created,
    existing: apps.length - leftOut.length - created,
    ...(leftOut.length > 0
      ? {
          note: `This instance lacks a Connection an App calls, so the seed left out ${leftOut.join(", ")}.`
        }
      : {})
  });
}
