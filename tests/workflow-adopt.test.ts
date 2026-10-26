import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptAssetRepositoryResponseSchema,
  type AdoptAssetRepositoryResponse
} from "@work-shape/catalyst-api-contract";
import {
  WORKFLOW_ASSET_KIND,
  type ConfigAssetRevisionRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { createAssetRepoJobs, type AssetRepoCommitRunner } from "@work-shape/catalyst-server";
import { SCOPES_HEADER, SERVICE_HEADER, clientInstanceId } from "./support/access-instance";
import { localAssetRepoCommit, readRepoCommit } from "./support/asset-repo";
import { recordJobErrors } from "./support/job-diagnostics";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";

// The adoption of Workflows written before their writes were commits (WF-GIT-2), against a
// real Postgres and the git of this machine: `assets.adopt_repository` with the release key
// gives every revision its folder as a file set and one commit, oldest first, with the
// revision's author and time, so a second run and a run after a stop make the same commits.

const RELEASE = { [SERVICE_HEADER]: "svc_release" };

const script = (factor: number) => `print(${factor})\n`;

/** The definition an earlier release stored, one step reading `steps/run.py`. */
const definition = (name: string, label: string): JsonObject => ({
  id: name,
  name: label,
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "code0",
      name: "Run",
      type: "code",
      file: "run.py",
      input: {},
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
});

let open: WorkflowFixture | undefined;
const directories: string[] = [];
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** Commits with git, and lets a test step in before a commit is made. */
async function ready() {
  const objects = new MemoryObjectStorage();
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets", files: objects }
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "workflow-adopt-test-"));
  directories.push(tempRoot);
  const git = await localAssetRepoCommit(join(tempRoot, "commits"));
  const hooks: {
    before?: () => Promise<void>;
    /** Throws to stop the worker once the commit is made, before anything names it. */
    after?: (commit: string) => void;
  } = {};
  const made: string[] = [];
  const commit: AssetRepoCommitRunner = async (input) => {
    await hooks.before?.();
    const outcome = await git(input);
    if (outcome.status === "committed") {
      made.push(outcome.commit);
      hooks.after?.(outcome.commit);
    }
    return outcome;
  };
  t.worker(
    createAssetRepoJobs({
      clientInstanceId,
      stores: t.stores,
      objects,
      workspaceObjects: undefined,
      logger: recordJobErrors(t.workerLogs),
      commit
    }).handlers
  ).start();

  /** Writes as an earlier release did: the config alone, no file set. */
  const writeOldRevision = async (
    name: string,
    base: number | null,
    write: { index: number } | "delete"
  ) => {
    const key = `${WORKFLOW_ASSET_KIND}:${name}`;
    const written = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      actor: {
        userId: t.admin.id,
        subjectUserId: t.admin.id,
        principalKind: "user",
        displayLabel: "Admin",
        roles: []
      },
      baseRevisions: { [key]: base },
      mutations: [
        write === "delete"
          ? { type: "delete", kind: WORKFLOW_ASSET_KIND, name }
          : {
              type: "upsert",
              kind: WORKFLOW_ASSET_KIND,
              name,
              draft: true,
              config: {
                name,
                manifest: definition(name, `${name} ${write.index}`),
                files: [{ path: "steps/run.py", content: script(write.index) }]
              }
            }
      ]
    });
    return written.revisions[key] ?? null;
  };
  /** Writes `count` revisions as an earlier release did. */
  const writeOld = async (name: string, count: number) => {
    let base: number | null = null;
    for (let index = 0; index < count; index += 1) {
      base = await writeOldRevision(name, base, { index });
    }
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name
    });
    if (!asset) throw new Error("not stored");
    return asset.id;
  };
  const revisions = (name: string): Promise<ConfigAssetRevisionRecord[]> =>
    t.stores.configAssets.listConfigAssetRevisions({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name
    });
  const ledger = (assetId: string) =>
    t.stores.configAssets.listAssetRepoBundles({ clientInstanceId, assetId });
  const adoptOnce = (
    body: { name?: string; after?: string } = {},
    headers: Record<string, string> = RELEASE
  ) =>
    t.instance.call("assets.adopt_repository", {
      params: { kind: WORKFLOW_ASSET_KIND },
      payload: body,
      headers
    });
  /** Calls until the instance says it is done, as the CLI does. */
  const adopt = async (body: { name?: string } = {}) => {
    const answers: { answer: AdoptAssetRepositoryResponse; body: string }[] = [];
    let after: string | undefined;
    for (;;) {
      const response = await adoptOnce({ ...body, ...(after === undefined ? {} : { after }) });
      expect(response.statusCode, response.body).toBe(200);
      const answer = adoptAssetRepositoryResponseSchema.parse(response.json());
      answers.push({ answer, body: response.body });
      if (answer.done) break;
      after = answer.after;
    }
    const sum = (key: "adopted" | "revisions" | "commits" | "refused") =>
      answers.reduce((total, { answer }) => total + answer[key], 0);
    return {
      adopted: sum("adopted"),
      revisions: sum("revisions"),
      commits: sum("commits"),
      refused: sum("refused"),
      adoptedAssetIds: answers.flatMap(({ answer }) => answer.adoptedAssetIds),
      bodies: answers.map(({ body }) => body)
    };
  };
  return {
    t,
    objects,
    hooks,
    made,
    writeOld,
    writeOldRevision,
    revisions,
    ledger,
    adopt,
    adoptOnce
  };
}

describe("the adoption of Workflows from before their repositories", () => {
  // Fails without the operation: every revision of these Workflows stays without a commit.
  it("commits every revision once, oldest first, by its author at its time, and a second run changes nothing", async () => {
    const { t, objects, writeOld, revisions, ledger, adopt } = await ready();
    const names = ["adopt-one", "adopt-five", "adopt-twenty"];
    const counts = [1, 5, 20];
    const ids: string[] = [];
    for (const [index, name] of names.entries()) {
      ids.push(await writeOld(name, counts[index] ?? 0));
    }
    for (const name of names) {
      expect((await revisions(name)).every((revision) => revision.commit === undefined)).toBe(true);
    }

    const first = await adopt();
    expect(first).toMatchObject({ adopted: 3, revisions: 26, commits: 26, refused: 0 });
    expect([...first.adoptedAssetIds].sort()).toEqual([...ids].sort());
    // The answer walks Personal Workspaces too: it holds ids and counts, never a name.
    for (const body of first.bodies) {
      for (const name of names) expect(body).not.toContain(name);
    }

    for (const [index, name] of names.entries()) {
      const assetId = ids[index] ?? "";
      const all = await revisions(name);
      const bundles = await ledger(assetId);
      expect(bundles).toHaveLength(all.length);
      for (const [position, revision] of all.entries()) {
        expect(revision.commit).toBeDefined();
        expect(revision.fileSetId).toBeDefined();
        const read = await readRepoCommit(objects, bundles, revision.commit ?? "");
        expect(read.commits).toBe(position + 1);
        expect(read.parent).toBe(all[position - 1]?.commit);
        expect(read.author).toBe(t.admin.id);
        expect(read.tree).toBe(revision.tree);
        expect(read.files["steps/run.py"]).toBe(script(position));
      }
    }
    const audit = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 })).filter(
      (event) => event.type === "asset.repository_adopted"
    );
    expect(
      audit
        .map(({ metadata }) => ({
          assetId: metadata?.assetId,
          revisions: metadata?.revisions,
          commits: metadata?.commits
        }))
        .sort((left, right) => Number(left.revisions) - Number(right.revisions))
    ).toEqual(
      counts.map((count, index) => ({ assetId: ids[index], revisions: count, commits: count }))
    );
    expect(JSON.stringify(audit)).not.toMatch(/adopt-(one|five|twenty)/u);

    const before = await Promise.all(names.map(revisions));
    const second = await adopt();
    expect(second).toMatchObject({ adopted: 0, revisions: 0, commits: 0, refused: 0 });
    expect(await Promise.all(names.map(revisions))).toEqual(before);
  }, 300_000);

  // Fails where a deletion is given a commit of its own, or none: the Workflow written again
  // after it would not stand on the history it had.
  it("keeps the commit before a deletion on its tombstone, and commits the Workflow written again on it", async () => {
    const { objects, writeOld, writeOldRevision, revisions, ledger, adopt } = await ready();
    const name = "adopt-deleted";
    const assetId = await writeOld(name, 2);
    const tombstone = await writeOldRevision(name, 2, "delete");
    await writeOldRevision(name, tombstone, { index: 7 });
    expect(await adopt({ name })).toMatchObject({ adopted: 1, revisions: 4, commits: 3 });
    const [first, second, deleted, again] = await revisions(name);
    expect(deleted?.config).toBeNull();
    expect(deleted?.commit).toBe(second?.commit);
    expect(deleted?.tree).toBe(second?.tree);
    const bundles = await ledger(assetId);
    expect(bundles).toHaveLength(3);
    const read = await readRepoCommit(objects, bundles, again?.commit ?? "");
    expect(read.parent).toBe(second?.commit);
    expect(read.commits).toBe(3);
    expect(read.files["steps/run.py"]).toBe(script(7));
    expect(first?.commit).toBeDefined();
  }, 300_000);

  // Fails where the draft is committed without its lock: the revision the write added meanwhile
  // stays without a commit, and the Workflow has a repository for part of its revisions.
  it("commits a revision a write adds during the adoption", async () => {
    const { t, hooks, writeOld, revisions, ledger, adopt } = await ready();
    const name = "adopt-busy";
    const assetId = await writeOld(name, 4);
    let wrote = false;
    hooks.before = async () => {
      if (wrote) return;
      wrote = true;
      const draft = (await revisions(name)).at(-1)?.revision ?? 0;
      const response = await t.call(t.admin.id, "assets.put", {
        params: { kind: WORKFLOW_ASSET_KIND, name },
        payload: {
          config: {
            name,
            manifest: definition(name, "written meanwhile"),
            files: [{ path: "steps/run.py", content: script(99) }]
          },
          expectedRevision: draft
        }
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const answer = await adopt({ name });
    expect(answer).toMatchObject({ adopted: 1, revisions: 5, commits: 5, refused: 0 });
    const all = await revisions(name);
    expect(all).toHaveLength(5);
    expect(all.every((revision) => revision.commit !== undefined)).toBe(true);
    expect(await ledger(assetId)).toHaveLength(5);
  }, 300_000);

  // Fails where the commit of a revision takes the time or the author of the run: the commit
  // made after the stop is another than the one the stopped run made.
  it("makes the same commits when run again after a stop half way", async () => {
    const { hooks, made, writeOld, revisions, adopt, adoptOnce } = await ready();
    const name = "adopt-stopped";
    await writeOld(name, 6);
    // The worker stops once it made the fourth commit, before any row names it.
    hooks.after = () => {
      if (made.length !== 4) return;
      hooks.after = undefined;
      throw new Error("The worker stopped");
    };
    const stopped = await adoptOnce({ name });
    expect(stopped.statusCode).toBeGreaterThanOrEqual(500);
    const half = await revisions(name);
    expect(half.filter((revision) => revision.commit !== undefined)).toHaveLength(3);
    const kept = half.map((revision) => revision.commit);

    const answer = await adopt({ name });
    expect(answer).toMatchObject({ adopted: 1, revisions: 3, commits: 3 });
    const all = await revisions(name);
    expect(all.slice(0, 3).map((revision) => revision.commit)).toEqual(kept.slice(0, 3));
    // The fourth commit was made twice, the same both times.
    expect(made[4]).toBe(made[3]);
    expect(all.map((revision) => revision.commit)).toEqual([...made.slice(0, 4), ...made.slice(5)]);
  }, 300_000);

  // Fails where the operation asks a writer's right: a person who may write Workflows rewrites
  // the history of every Workflow of the instance, Personal Workspaces among them.
  it("refuses a caller without the release right, and a key without the release scope", async () => {
    const { t, writeOld, revisions, adoptOnce } = await ready();
    const name = "adopt-refused";
    await writeOld(name, 2);
    const asAdmin = await t.call(t.root.id, "assets.adopt_repository", {
      params: { kind: WORKFLOW_ASSET_KIND },
      payload: {}
    });
    expect(asAdmin.statusCode, asAdmin.body).toBe(403);
    const narrowKey = await adoptOnce({}, { ...RELEASE, [SCOPES_HEADER]: "config_assets:write" });
    expect(narrowKey.statusCode, narrowKey.body).toBe(403);
    expect((await revisions(name)).every((revision) => revision.commit === undefined)).toBe(true);
  }, 300_000);
});
