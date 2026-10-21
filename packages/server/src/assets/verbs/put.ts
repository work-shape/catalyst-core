import { createAgentWithDependencies } from "../agent-creation";
import { type AgentAvailability, AppError } from "@work-shape/catalyst-core";
import type { AssetFileInput } from "../asset-files";
import type { AssetCall } from "../asset-access";
import { requireMatchingConfigName } from "../asset-write-rules";
import {
  assertStoredWritable,
  requireExpectedRevision,
  requireOwnScope,
  type AssetAddress
} from "../asset-target";
import type { AvailableIn } from "../asset-placement";
import { requirePrecondition } from "../asset-revision";
import type { AssetWorkflowOptions } from "../../types";
import { writeAssetConfig } from "./apply";
import type { AssetVerbScope } from "./scope";
import { requireFurtherRight } from "./revision-rights";

/**
 * Creates the asset, or replaces it at the revision the caller read. `null` as the expected
 * revision creates it and is refused where the name is taken or was deleted: a deleted
 * asset is created again by naming the revision of its delete. A call that names no
 * revision is refused.
 */
export async function putAsset(
  scope: AssetVerbScope,
  call: AssetCall,
  input: AssetAddress & {
    config?: Record<string, unknown>;
    files?: readonly AssetFileInput[];
    expectedRevision?: number | null;
    expectedDraftRevision?: number | null;
    availableIn?: AvailableIn;
    makeDependenciesAvailable?: boolean;
    expectedAvailability?: Omit<AgentAvailability, "collaborationWorkspaceIds"> & {
      collaborationWorkspaceIds: string[];
    };
  }
) {
  const target = await scope.target(input);
  const { kind } = target;
  call.access.require(kind.actions.write, target.resource);
  await requireFurtherRight(scope, call.access, target, "write", input.config);
  const expectedRevision = requirePrecondition(input, input.expectedRevision);
  await scope.authorizeEditing(call, "put");
  assertStoredWritable(target, call.access);
  if (kind.representation === "files") {
    return scope.drafts.putFiles(call, target, { ...input, expectedRevision });
  }
  if (kind.revisionFiles && input.files !== undefined) {
    if (input.config !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `A ${kind.kind} is written as its config or as its files, with '${kind.revisionFiles.manifestFile}' among them, and not as both at once`,
        { reason: "config_and_files" }
      );
    }
    requireOwnScope(target, call.access);
    await requireExpectedRevision(scope.options, call, target, expectedRevision);
    assertStoredWritable(target, "always");
    return scope.drafts.putFolder(call, target, input.files, expectedRevision);
  }
  if (input.config === undefined || input.files !== undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `A ${kind.kind} is written as its config. It holds no files`,
      { reason: "config_required" }
    );
  }
  requireMatchingConfigName(input.config, input.name);
  requireOwnScope(target, call.access);
  await requireExpectedRevision(scope.options, call, target, expectedRevision);
  assertStoredWritable(target, "always");
  const config = input.config;
  const write = (within: AssetWorkflowOptions, called: AssetCall) =>
    writeAssetConfig(scope.within(within), called, target, config, {
      expectedRevision,
      audit: "config_asset.updated",
      expectedDraftRevision: input.expectedDraftRevision ?? null,
      ...(input.availableIn === undefined ? {} : { availableIn: input.availableIn })
    });
  return input.makeDependenciesAvailable
    ? createAgentWithDependencies(scope.options, call, input, write)
    : write(scope.options, call);
}
