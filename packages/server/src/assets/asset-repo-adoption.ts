import { createHash } from "node:crypto";
import type { AdoptAssetRepositoryResponse } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  auditActorFromIdentity,
  isAppError,
  isOperationRunId,
  type AuditActor,
  type ConfigAssetRevisionRecord,
  type FileSetId,
  type JsonObject,
  type OperationRunId
} from "@work-shape/catalyst-core";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import type { AssetWorkflowOptions } from "../types";
import type { AssetCall } from "./asset-access";
import { removeUnnamedAssetFileSet, storeRevisionFiles } from "./asset-files";
import { commitAssetFileSet, reasonOf, repositoryObjectSize } from "./asset-repo-save";

// The adoption of the assets of a kind whose content is a repository, written before the kind
// had one (WF-GIT-2): an operator's deploy step after the release, never a step of startup.
// Every revision gets the folder its config makes as its file set, where it names none, and
// then one commit, oldest first, on the commit of the revision before it. The author and the
// time are the revision's, and the save of each revision is keyed by the revision, so a second
// run, or one after a stop, makes the same commits and finds those made before.
//
// It walks every workspace, Personal Workspaces among them (ADR-0015): the answer, the audit
// and the log name asset ids and counts, never a name or content.
//
// Nothing here knows a kind of asset.

/**
 * How long one call starts new commits. A commit is a container for a few seconds, so a call
 * answers well within the five minutes of an operation, and the caller goes on with `after`.
 */
const ADOPTION_CALL_BUDGET_MS = 30_000;

/** Who wrote an earlier asset revision, as a commit names its author: the opaque id. */
function authorOfRevision(actor: AuditActor | null): string {
  if (actor?.principalKind === "service" && actor.principalId) return actor.principalId;
  return actor?.subjectUserId ?? actor?.userId ?? "catalyst";
}

/**
 * The save of one revision's commit. Keyed by the revision, so every run finds the commit an
 * earlier one made, and no two saves name the same bundle. A save left pending for a day is
 * given up by the sweeper; until its row is gone a day later, its asset is refused, and a run
 * after that commits it again.
 */
function adoptionRunId(revision: ConfigAssetRevisionRecord): OperationRunId {
  const digest = createHash("sha256").update(`adopt:${revision.id}`).digest("hex");
  const id = `oprun_adopt_${digest.slice(0, 40)}`;
  if (!isOperationRunId(id)) throw new AppError("INTERNAL", "Not the id of an Operation Run");
  return id;
}

/** What the store answers for a revision it will not fill, on this run and every later one. */
const STORE_REFUSALS = ["CONFLICT", "NOT_FOUND", "VALIDATION_FAILED"];

type AssetOutcome =
  | { status: "adopted"; revisions: number; commits: number }
  | { status: "refused"; revisions: number; commits: number }
  | { status: "unfinished"; revisions: number; commits: number };

export async function adoptAssetRepositories(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: { kind: string; name?: string; after?: string }
): Promise<AdoptAssetRepositoryResponse> {
  const kind = options.configAssets.kinds.get(input.kind);
  if (!kind || kind.content !== "repository" || !kind.revisionFiles || !options.pages) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The content of a ${input.kind} is no repository on this instance: there is nothing to adopt`,
      { reason: "kind_without_repository" },
      { exposeMessage: true }
    );
  }
  const deadline = Date.now() + ADOPTION_CALL_BUDGET_MS;
  const answer: AdoptAssetRepositoryResponse = {
    adopted: 0,
    revisions: 0,
    commits: 0,
    refused: 0,
    adoptedAssetIds: [],
    refusedAssetIds: [],
    done: false
  };
  let after = input.after;
  for (;;) {
    const [asset] = await options.stores.configAssets.listAssetsWithoutCommits({
      clientInstanceId: options.clientInstanceId,
      kind: kind.kind,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(after === undefined ? {} : { after }),
      limit: 1
    });
    if (!asset) return { ...answer, done: true, ...(after === undefined ? {} : { after }) };
    if (Date.now() >= deadline) return { ...answer, ...(after === undefined ? {} : { after }) };
    const outcome = await adoptAsset(options, call, kind, asset, deadline);
    answer.revisions += outcome.revisions;
    answer.commits += outcome.commits;
    if (outcome.status === "unfinished") {
      return { ...answer, ...(after === undefined ? {} : { after }) };
    }
    if (outcome.status === "refused") {
      answer.refused += 1;
      answer.refusedAssetIds.push(asset.id);
    } else {
      answer.adopted += 1;
      answer.adoptedAssetIds.push(asset.id);
      const all = await revisionsOf(options, kind, asset);
      await call.audit.record({
        type: "asset.repository_adopted",
        status: "success",
        actor: auditActorFromIdentity(call.actor),
        subject: asset.id,
        correlationId: call.correlationId,
        metadata: {
          assetId: asset.id,
          revisions: all.length,
          commits: all.filter((revision) => revision.config !== null).length
        }
      });
    }
    after = asset.id;
  }
}

/** The revisions of the asset, oldest first. A name used again by another asset is not its. */
async function revisionsOf(
  options: AssetWorkflowOptions,
  kind: WorkflowAssetKind,
  asset: { id: string; name: string }
): Promise<ConfigAssetRevisionRecord[]> {
  const revisions = await options.stores.configAssets.listConfigAssetRevisions({
    clientInstanceId: options.clientInstanceId,
    kind: kind.kind,
    name: asset.name
  });
  return revisions.filter((revision) => revision.assetId === asset.id);
}

/**
 * Commits the revisions of one asset that name none, oldest first, until every revision names
 * one. A write that lands meanwhile adds a revision without a commit, which is committed next.
 * A revision whose config makes no folder refuses the asset before anything of it is written.
 */
async function adoptAsset(
  options: AssetWorkflowOptions,
  call: AssetCall,
  kind: WorkflowAssetKind,
  asset: { id: string; name: string },
  deadline: number
): Promise<AssetOutcome> {
  const hook = kind.revisionFiles;
  if (!hook) throw new AppError("INTERNAL", `A ${kind.kind} holds no files`);
  const store = options.stores.configAssets;
  const address = { clientInstanceId: options.clientInstanceId, assetId: asset.id };
  let revisions = 0;
  let commits = 0;
  const refuse = (revision: number, reason: unknown) => {
    options.logger.warn(
      { assetId: asset.id, revision, reason },
      "A revision of an asset could not be adopted into its repository"
    );
    return { status: "refused" as const, revisions, commits };
  };
  // Read once, and again where every revision read names a commit: a write that landed
  // meanwhile is the next to commit.
  let all = await revisionsOf(options, kind, asset);
  for (;;) {
    let index = all.findIndex((revision) => revision.commit === undefined);
    if (index < 0) {
      all = await revisionsOf(options, kind, asset);
      index = all.findIndex((revision) => revision.commit === undefined);
      if (index < 0) return { status: "adopted", revisions, commits };
    }
    const next = all[index];
    if (!next) return { status: "adopted", revisions, commits };
    const empty = all.find(
      (revision) =>
        revision.commit === undefined &&
        revision.config !== null &&
        revision.fileSetId === undefined &&
        hook.filesOfConfig(revision.config).length === 0
    );
    if (empty) return refuse(empty.revision, "no_folder");
    if (Date.now() >= deadline) return { status: "unfinished", revisions, commits };
    const before = all[index - 1];
    // What the store refuses of this revision holds for every later run too, and refuses the
    // asset. Anything else is the instance's, and the call ends with it: a later run goes on
    // where this one stopped.
    const refused = (error: unknown, codes: readonly string[]) =>
      isAppError(error) && codes.includes(error.code)
        ? refuse(next.revision, reasonOf(error) ?? error.code)
        : undefined;
    if (next.config === null) {
      try {
        await store.fillAssetRepoRevision({ ...address, revision: next.revision });
      } catch (error) {
        const outcome = refused(error, STORE_REFUSALS);
        if (outcome) return outcome;
        throw error;
      }
      all[index] = {
        ...next,
        ...(before?.commit === undefined ? {} : { commit: before.commit }),
        ...(before?.tree === undefined ? {} : { tree: before.tree })
      };
      revisions += 1;
      continue;
    }
    let fileSetId: FileSetId;
    try {
      fileSetId =
        next.fileSetId ?? (await storeFolder(options, kind, asset.id, next.revision, next.config));
    } catch (error) {
      const outcome = refused(error, STORE_REFUSALS);
      if (outcome) return outcome;
      throw error;
    }
    const fileSet = await options.stores.pages.getAssetFileSet({ ...address, fileSetId });
    if (!fileSet) return refuse(next.revision, "file_set_missing");
    let repository;
    try {
      repository = await commitAssetFileSet(options, {
        assetId: asset.id,
        operationRunId: adoptionRunId(next),
        fileSet,
        baseCommit: before?.commit ?? null,
        actor: call.actor,
        recorded: {
          author: authorOfRevision(next.actor),
          time: Math.floor(Date.parse(next.createdAt) / 1000)
        },
        kind: kind.kind,
        message:
          before === undefined
            ? `Create ${kind.kind} '${asset.name}'`
            : `Write ${kind.kind} '${asset.name}'`
      });
    } catch (error) {
      // A refusal of the files or the history. No worker, no room on its disk or a commit
      // that was not made in time is the instance's.
      const outcome = refused(error, ["VALIDATION_FAILED"]);
      if (outcome) return outcome;
      throw error;
    }
    try {
      await store.fillAssetRepoRevision({
        ...address,
        revision: next.revision,
        fileSetId,
        repository,
        repositoryObjectSize: repositoryObjectSize(options.pages?.objects)
      });
    } catch (error) {
      const outcome = refused(error, STORE_REFUSALS);
      if (outcome) return outcome;
      throw error;
    }
    all[index] = { ...next, fileSetId, commit: repository.commit, tree: repository.tree };
    revisions += 1;
    commits += 1;
  }
}

/**
 * Stores the folder the config of a revision makes and names it on the revision, before its
 * commit: a run that stops after this finds it there and commits the same files. Where another
 * run named one first, that one is the revision's and this one is removed.
 */
async function storeFolder(
  options: AssetWorkflowOptions,
  kind: WorkflowAssetKind,
  assetId: string,
  revision: number,
  config: JsonObject
): Promise<FileSetId> {
  const files = kind.revisionFiles?.filesOfConfig(config) ?? [];
  const stored = await storeRevisionFiles(options, { kind, assetId, files, extras: [] });
  if (!stored) throw new AppError("INTERNAL", "This instance has no store of files");
  let named: FileSetId | undefined;
  try {
    ({ fileSetId: named } = await options.stores.configAssets.fillAssetRepoRevision({
      clientInstanceId: options.clientInstanceId,
      assetId,
      revision,
      fileSetId: stored.id
    }));
  } finally {
    if (named !== stored.id) {
      await removeUnnamedAssetFileSet(options, assetId, stored.id).catch(() => undefined);
    }
  }
  if (!named) throw new AppError("INTERNAL", "The revision names no file set");
  return named;
}
